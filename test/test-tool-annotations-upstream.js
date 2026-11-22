/** Regression: read-only MCP tools explicitly advertise non-destructive behavior. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createTestEnv, isTestHome } from './helpers/test-env.js';

async function testAnnotations() {
  const { server } = await import('../dist/server.js');
  const listHandler = server._requestHandlers.get('tools/list');
  assert(listHandler, 'tools/list request handler is available');
  const result = await listHandler({ method: 'tools/list' }, {});
  assert(Array.isArray(result.tools));
  let checked = 0;
  for (const tool of result.tools) {
    if (tool.annotations?.readOnlyHint === true) {
      assert.equal(tool.annotations.destructiveHint, false,
        `${tool.name}: read-only tools must explicitly reject destructive behavior`);
      checked += 1;
    }
  }
  assert(checked >= 15, `Expected at least 15 read-only tools; got ${checked}`);
  for (const name of ['get_config', 'read_file', 'list_directory', 'read_process_output']) {
    const tool = result.tools.find((entry) => entry.name === name);
    assert(tool, `Missing tool ${name}`);
    assert.equal(tool.annotations?.readOnlyHint, true);
  }
  const write = result.tools.find((entry) => entry.name === 'write_file');
  assert(write, 'Missing write_file');
  assert.equal(write.annotations?.readOnlyHint, false,
    'A mutating file tool must not be advertised as read-only');
  console.log(`PASS: ${checked} read-only tools expose non-destructive metadata`);
}
if (!isTestHome()) {
  const isolated = createTestEnv();
  try {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      env: isolated.env, stdio: 'inherit', timeout: 90_000,
    });
    assert.equal(child.status, 0, child.error?.message || 'tool annotation test failed');
  } finally {
    isolated.cleanup();
  }
} else {
  await testAnnotations();
}
