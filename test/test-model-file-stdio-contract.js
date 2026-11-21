/** Live MCP stdio contract: model-facing file tools must expose content[], not a success-only object. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createTestEnv, isTestHome } from './helpers/test-env.js';
import { connectToServer, closeClient } from './helpers/mcp-client.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function run() {
const client = await connectToServer('file-content-stdio-contract');
try {
  const { tools } = await client.listTools();
  for (const name of ['read_file', 'list_directory', 'write_file', 'edit_block']) {
    const tool = tools.find((candidate) => candidate.name === name);
    assert(tool, `missing MCP descriptor for ${name}`);
    assert(tool.outputSchema?.properties?.text, `${name} must advertise structured text`);
  }

  const read = await client.callTool({ name: 'read_file', arguments: {
    path: path.join(root, 'package.json'), offset: 0, length: 5,
  } });
  assert(!read.isError, 'model-facing read_file should succeed');
  assert.match(read.structuredContent?.text ?? '', /wonderwhy-er\/desktop-commander/, 'structured-only adapters must receive text');
  assert.match(JSON.stringify(read.content), /wonderwhy-er\/desktop-commander/);

  const directory = await client.callTool({ name: 'list_directory', arguments: { path: root, depth: 1 } });
  assert(!directory.isError, 'model-facing list_directory should succeed');
  assert.match(directory.structuredContent?.text ?? '', /package\.json/, 'structured-only adapters must receive listing');
  assert.match(JSON.stringify(directory.content), /package\.json/);

  // A UI-origin preview keeps its structured metadata without an outputSchema.
  const preview = await client.callTool({ name: 'read_file', arguments: {
    path: path.join(root, 'package.json'), origin: 'ui', offset: 0, length: 3,
  } });
  assert(!preview.isError, 'UI-origin preview should succeed');
  assert.equal(preview.structuredContent?.fileName, 'package.json');
  assert.equal(preview.structuredContent?.success, true);

  const missing = await client.callTool({ name: 'read_file', arguments: {
    path: path.join(root, 'missing-model-contract-test.txt'),
  } });
  assert(missing.isError, 'missing files must preserve MCP error status');
  assert.match(JSON.stringify(missing.content), /ENOENT|not found|Error/i);

  console.log('PASS: real stdio MCP tool discovery and file content/error delivery');
} finally {
  await closeClient(client);
}
}

// Prevent direct test invocation from reading or modifying the user's MCP config.
if (!isTestHome()) {
  const isolated = createTestEnv();
  try {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      env: isolated.env, stdio: 'inherit', timeout: 90_000,
    });
    assert.equal(child.status, 0, child.error?.message || 'isolated stdio test failed');
  } finally {
    isolated.cleanup();
  }
} else {
  await run();
}
