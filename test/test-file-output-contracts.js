import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createTestEnv, isTestHome } from './helpers/test-env.js';

if (!isTestHome()) {
  const isolated = createTestEnv();
  try {
    const child = spawnSync(process.execPath, [import.meta.filename], { env: isolated.env, stdio: 'inherit', timeout: 45_000 });
    assert.equal(child.status, 0, child.error?.message);
  } finally { isolated.cleanup(); }
} else {
  const { server } = await import('../dist/server.js');
  const { enrichStructuredContent } = await import('../dist/structured-content.js');
  const { budgetToolResponse } = await import('../dist/utils/response-budget.js');
  const { usageTracker } = await import('../dist/utils/usageTracker.js');
  const { toolHistory } = await import('../dist/utils/toolHistory.js');
  usageTracker.trackSuccess = async () => {};
  usageTracker.trackFailure = async () => {};
  usageTracker.shouldShowOnboarding = async () => false;
  usageTracker.shouldPromptForFeedback = async () => false;
  const listed = await server._requestHandlers.get('tools/list')({ method: 'tools/list' }, {});
  const tools = ['read_file', 'write_file', 'edit_block', 'list_directory'];
  // Model-facing content-bearing tools cannot advertise metadata-only schemas:
  // structured-only MCP hosts would otherwise hide their text and image bodies.
  for (const name of tools) {
    const descriptor = listed.tools.find(tool => tool.name === name);
    assert(descriptor, `${name} must be present in tools/list`);
    assert.equal(descriptor.outputSchema, undefined, `${name} must deliver content[] to models`);
  }
  for (const name of tools) {
    for (const content of [[], [{ type: 'text', text: 'original body' }], [{ type: 'image', data: 'AA==', mimeType: 'image/png' }]]) {
      for (const isError of [false, true]) {
        const result = enrichStructuredContent(name, { content, isError });
        assert.equal(result.content, content, 'original bodies stay intact');
        assert.equal(result.structuredContent, undefined, 'model-facing bodies have no substitute structured result');
      }
    }
    const ui = enrichStructuredContent(name, { content: [], structuredContent: {
      filePath: 'X:\\example.txt', fileName: 'example.txt', fileType: 'text', content: 'widget body',
    } });
    assert.equal(ui.structuredContent.content, 'widget body');
    assert.equal(ui.structuredContent.path, 'X:\\example.txt');
    assert.equal(ui.structuredContent.success, true, 'UI preview metadata remains available');
    const large = budgetToolResponse(enrichStructuredContent(name, { content: [{ type: 'text', text: 'x'.repeat(70_000) }] }));
    assert(JSON.stringify(large).length < 34_000, 'response budgeting remains bounded');
  }
  const target = path.join(os.homedir(), 'contract.txt');
  const handler = server._requestHandlers.get('tools/call');
  const call = async (name, args) => {
    const result = await handler({ method: 'tools/call', params: { name, arguments: args } }, {});
    assert.equal(result.structuredContent, undefined, `${name} model result must not mask content[]`);
    return result;
  };
  assert(!(await call('write_file', { path: target, content: 'before\n', mode: 'rewrite' })).isError);
  const read = await call('read_file', { path: target });
  assert(JSON.stringify(read.content).includes('before'));
  assert.equal(read.structuredContent, undefined);
  const directory = await call('list_directory', { path: os.homedir() });
  assert(JSON.stringify(directory.content).includes('contract.txt'));
  assert(!(await call('edit_block', { file_path: target, old_string: 'before', new_string: 'after' })).isError);
  assert.equal(fs.readFileSync(target, 'utf8'), 'after\n');
  const missing = await call('read_file', { path: path.join(os.homedir(), 'does-not-exist.txt') });
  assert(missing.isError);
  assert.match(JSON.stringify(missing.content), /does-not-exist|ENOENT|Error/i);
  await toolHistory.cleanup();
  console.log('PASS: model content remains visible without misleading outputSchema; UI metadata, errors, media and budgets preserved');
}
