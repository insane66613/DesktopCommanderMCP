import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createTestEnv, isTestHome } from './helpers/test-env.js';

if (!isTestHome()) {
  const isolated = createTestEnv();
  try {
    const child = spawnSync(process.execPath, [import.meta.filename], { env: isolated.env, stdio: 'inherit', timeout: 30_000 });
    assert.equal(child.status, 0, child.error?.message);
  } finally { isolated.cleanup(); }
} else {
  const { ReceiveFileArgsSchema } = await import('../dist/tools/schemas.js');
  const { handleReceiveFile } = await import('../dist/handlers/filesystem-handlers.js');
  const { server } = await import('../dist/server.js');
  const { toolHistory } = await import('../dist/utils/toolHistory.js');
  const { trackToolCall } = await import('../dist/utils/trackTools.js');
  const { TOOL_CALL_FILE } = await import('../dist/config.js');
  const { redactToolArguments } = await import('../dist/utils/tool-argument-privacy.js');
  const file = { download_url: 'https://example.com/file?signature=secret-marker', file_id: 'file-test' };
  const target = path.join(process.env.USERPROFILE, 'received.bin');
  assert(ReceiveFileArgsSchema.safeParse({ path: target, file }).success);
  assert(ReceiveFileArgsSchema.safeParse({ path: target, content: '' }).success);
  assert(!ReceiveFileArgsSchema.safeParse({ path: target }).success);
  assert(!ReceiveFileArgsSchema.safeParse({ path: target, file, content: '' }).success);
  assert(!ReceiveFileArgsSchema.safeParse({ path: target, file: { download_url: file.download_url } }).success);
  const list = await server._requestHandlers.get('tools/list')({ method: 'tools/list' }, {});
  const descriptor = list.tools.find(t => t.name === 'receive_file');
  assert.deepEqual(descriptor._meta['openai/fileParams'], ['file']);
  assert.equal(descriptor.annotations.openWorldHint, true);
  const schema = descriptor.inputSchema.properties.file;
  assert.deepEqual(Object.keys(schema.properties).sort(), ['download_url', 'file_id', 'file_name', 'mime_type']);
  assert.deepEqual(schema.required.sort(), ['download_url', 'file_id']);
  assert(!descriptor.inputSchema.required.includes('content'));
  assert(!descriptor.inputSchema.required.includes('file'));
  const invalidBoth = await handleReceiveFile({ path: target, file, content: '' });
  assert(invalidBoth.isError);
  assert(!fs.existsSync(target));
  const append = await handleReceiveFile({ path: target, file, mode: 'append' });
  assert(append.isError);
  assert(!fs.existsSync(target));
  const relative = `native-relative-${process.pid}/file.bin`;
  assert((await handleReceiveFile({ path: relative, file, createParentDirectories: true })).isError);
  assert(!fs.existsSync(path.dirname(relative)), 'invalid native input must not create directories');
  const cancelled = await server._requestHandlers.get('tools/call')({ method: 'tools/call', params: {
    name: 'receive_file', arguments: { path: target, file },
  } }, { signal: AbortSignal.abort() });
  assert(cancelled.isError);
  assert(JSON.stringify(cancelled).includes('cancelled or timed out'), 'MCP cancellation reaches the downloader');
  assert(!fs.existsSync(target));
  const bytes = Buffer.from([0, 255, 128, 13, 10, 0, 42]);
  const legacy = await handleReceiveFile({ path: target, content: bytes.toString('base64'), encoding: 'base64' });
  assert(!legacy.isError);
  assert.deepEqual(fs.readFileSync(target), bytes);
  const existing = await handleReceiveFile({ path: target, content: 'replacement', encoding: 'utf8' });
  assert(existing.isError);
  assert.deepEqual(fs.readFileSync(target), bytes);
  const textTarget = path.join(process.env.USERPROFILE, 'plain.txt');
  const text = await handleReceiveFile({ path: textTarget, content: 'legacy text\n', encoding: 'utf8' });
  assert(!text.isError);
  assert.equal(fs.readFileSync(textTarget, 'utf8'), 'legacy text\n');
  const args = { path: target, file };
  assert.equal(redactToolArguments('receive_file', args).file.download_url, '[redacted]');
  assert.equal(args.file.download_url, file.download_url, 'redaction must not mutate execution arguments');
  toolHistory.addCall('receive_file', args, { content: [] });
  await trackToolCall('receive_file', args);
  await toolHistory.cleanup();
  assert(!JSON.stringify(toolHistory.getRecentCalls({})).includes('secret-marker'));
  assert(!fs.readFileSync(toolHistory.getStats().historyFile, 'utf8').includes('secret-marker'));
  assert(!fs.readFileSync(TOOL_CALL_FILE, 'utf8').includes('secret-marker'));
  console.log('PASS: native descriptor, exclusive sources, backward compatibility, exact binary bytes and signed URL privacy');
}
