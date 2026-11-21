/** Verify that all DeskCommand code-writing routes expose agent-side Context7 guidance. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { connectToServer, closeClient } from './helpers/mcp-client.js';
import { createTestEnv, isTestHome } from './helpers/test-env.js';

const CODE_WRITE_TOOLS = ['write_file', 'edit_block', 'start_process', 'interact_with_process'];

async function run() {
  const client = await connectToServer('context7-tool-metadata-test');
  try {
    const { tools } = await client.listTools();
    for (const name of CODE_WRITE_TOOLS) {
      const tool = tools.find((item) => item.name === name);
      assert(tool, `Missing MCP tool: ${name}`);
      assert.match(tool.description, /SC-GOV-CONTEXT7-001/, `Missing rule in ${name}`);
      assert.match(tool.description, /separate Context7 MCP/, `Missing Context7 route in ${name}`);
      assert.match(tool.description, /manifest\/lockfile versions/, `Missing version check in ${name}`);
      assert.match(tool.description, /official upstream/, `Missing fallback in ${name}`);
    }
    const read = tools.find((item) => item.name === 'read_file');
    assert(read, 'Missing read_file');
    assert.doesNotMatch(read.description, /SC-GOV-CONTEXT7-001/,
      'Read-only tools must not acquire write preflight guidance');
    console.log('PASS: four code-writing MCP tools publish Context7 preflight guidance');
  } finally {
    await closeClient(client);
  }
}

if (!isTestHome()) {
  const isolated = createTestEnv();
  try {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      env: isolated.env, stdio: 'inherit', timeout: 90_000,
    });
    assert.equal(child.status, 0, child.error?.message || 'isolated Context7 tool test failed');
  } finally {
    isolated.cleanup();
  }
} else {
  await run();
}
