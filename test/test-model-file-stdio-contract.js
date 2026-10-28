/** Live MCP stdio contract: model-facing file tools must expose content[], not a success-only object. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectToServer, closeClient } from './helpers/mcp-client.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const client = await connectToServer('file-content-stdio-contract');
try {
  const { tools } = await client.listTools();
  for (const name of ['read_file', 'list_directory', 'write_file', 'edit_block']) {
    const tool = tools.find((candidate) => candidate.name === name);
    assert(tool, `missing MCP descriptor for ${name}`);
    assert.equal(tool.outputSchema, undefined, `${name} must not mask content[]`);
  }

  const read = await client.callTool({ name: 'read_file', arguments: {
    path: path.join(root, 'package.json'), offset: 0, length: 5,
  } });
  assert(!read.isError, 'model-facing read_file should succeed');
  assert(!read.structuredContent, 'model-facing file content cannot be metadata-only');
  assert.match(JSON.stringify(read.content), /wonderwhy-er\/desktop-commander/);

  const directory = await client.callTool({ name: 'list_directory', arguments: { path: root, depth: 1 } });
  assert(!directory.isError, 'model-facing list_directory should succeed');
  assert(!directory.structuredContent, 'directory contents must not be suppressed');
  assert.match(JSON.stringify(directory.content), /package\.json/);

  const missing = await client.callTool({ name: 'read_file', arguments: {
    path: path.join(root, 'missing-model-contract-test.txt'),
  } });
  assert(missing.isError, 'missing files must preserve MCP error status');
  assert.match(JSON.stringify(missing.content), /ENOENT|not found|Error/i);

  console.log('PASS: real stdio MCP tool discovery and file content/error delivery');
} finally {
  await closeClient(client);
}
