/** Verify the real MCP tool-list advertises the editor-style pagination alias. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { connectToServer, closeClient } from './helpers/mcp-client.js';
import { createTestEnv, isTestHome } from './helpers/test-env.js';

async function run() {
  const client = await connectToServer('read-view-range-schema-test');
  try {
    const { tools } = await client.listTools();
    const read = tools.find(tool => tool.name === 'read_file');
    assert.ok(read, 'MCP read_file tool missing');
    const schema = read.inputSchema?.properties?.view_range;
    assert.ok(schema, 'view_range absent from published MCP JSON Schema');
    assert.equal(schema.type, 'array');
    assert.equal(schema.minItems, 2);
    assert.equal(schema.maxItems, 2);
    assert.ok(Array.isArray(schema.items));
    assert.equal(schema.items.length, 2);
    assert.equal(schema.items[0].type, 'integer');
    assert.equal(schema.items[0].minimum, 1);
    assert.equal(schema.items[1].type, 'integer');
    assert.equal(schema.items[1].minimum, -1);
    assert.match(read.description, /view_range/);
    assert.match(read.description, /Cannot be combined with offset or length/);
    console.log('PASS: MCP ListTools exports fixed-size, bounded read_file view_range tuple');
    console.log('NOTE: end>=start is enforced by the runtime Zod refine rule');
  } finally {
    await closeClient(client);
  }
}

if (!isTestHome()) {
  const sandbox = createTestEnv();
  try {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      env: sandbox.env, stdio: 'inherit', timeout: 90_000,
    });
    assert.equal(child.status, 0, child.error?.message ?? 'isolated schema test failed');
  } finally { sandbox.cleanup(); }
} else {
  await run();
}
