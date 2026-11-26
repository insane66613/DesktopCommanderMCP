import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createTestEnv } from './helpers/test-env.js';

const env = createTestEnv();
const serverFile = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverFile],
  env: env.env,
  stderr: 'pipe',
});
const client = new Client(
  { name: 'excel-analysis-tool-guidance-test', version: '1.0.0' },
  { capabilities: {} },
);

try {
  await client.connect(transport, { timeout: 30000 });
  const tools = (await client.listTools()).tools;
  const terminal = tools.find(t => t.name === 'start_process');
  assert(terminal, 'start_process must remain discoverable via MCP tools/list');
  const guidance = terminal.description ?? '';
  const required = [
    /ExcelJS/, /node:local/, /interact_with_process/,
    /read_file/, /edit_block/, /complete self-contained/,
    /Python is unavailable/, /browser-hosted analysis runtime/,
    /does not evaluate formulas/, /cached values/, /receive_file/,
    /console\.log\(\)/,
  ];
  for (const expression of required) {
    assert.match(guidance, expression, 'Missing guidance: ' + expression);
  }
  assert.ok(guidance.length < 12000, 'tool description must remain bounded');
  assert.ok(!tools.some(t => t.name === 'execute_node'),
    'obsolete execute_node tool must not be restored');
  for (const name of ['read_file', 'edit_block', 'interact_with_process']) {
    assert.ok(tools.some(t => t.name === name),
      'required local counterpart remains discoverable: ' + name);
  }
  console.log('PASS: live MCP tools/list exposes bounded local ExcelJS and Python fallback guidance');
} finally {
  await client.close().catch(() => {});
  env.cleanup();
}
