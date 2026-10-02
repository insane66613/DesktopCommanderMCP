import assert from 'node:assert/strict';
import { FilteredStdioServerTransport } from '../dist/custom-stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { EmptyResultSchema, LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { createTestEnv } from './helpers/test-env.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Exercise the actual console/stdout interception, not a duplicate of its policy.
const stdout = [], stderr = [];
const originalOut = process.stdout.write, originalErr = process.stderr.write;
process.stdout.write = chunk => { stdout.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')); return true; };
process.stderr.write = chunk => { stderr.push(String(chunk)); return true; };
const transport = new FilteredStdioServerTransport();
try {
  console.error('startup diagnostic');
  transport.sendLog('info', 'startup explicit log');
  assert.equal(transport.bufferedMessageCount, 0);
  transport.enableNotifications();
  console.log('configuration dump');
  transport.sendLog('error', 'default local error');
  process.stdout.write(Buffer.from('non protocol output'));
  let callbackCalled = false;
  process.stdout.write(new Uint8Array(Buffer.from('binary diagnostic')), () => { callbackCalled = true; });
  assert.equal(callbackCalled, false, 'filtered write callbacks must remain asynchronous');
  await new Promise(resolve => process.nextTick(resolve));
  assert.equal(callbackCalled, true);
  assert.equal(stdout.length, 0, 'diagnostics and startup replay must not reach the MCP client');
  const result = '{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n';
  process.stdout.write(result);
  assert.equal(stdout.pop(), result, 'protocol tool responses must remain unchanged');
  const padded = Buffer.from('abc' + result + 'xyz');
  process.stdout.write(new Uint8Array(padded.buffer, padded.byteOffset + 3, Buffer.byteLength(result)));
  assert.equal(stdout.pop(), result, 'Uint8Array protocol frame must respect its exact byte view');
  transport.setLogLevel('warning');
  transport.sendLog('info', 'below requested severity');
  transport.sendLog('error', 'requested diagnostic', { privateFixture: 'must remain local' });
  assert.equal(stdout.length, 1);
  const notification = JSON.parse(stdout.pop());
  assert.equal(notification.method, 'notifications/message');
  assert.equal(notification.params.data, 'requested diagnostic');
  console.error('console remains local even after opt-in');
  assert.equal(stdout.length, 0);
  transport.sendProgress('fixture', 1, 2);
  assert.equal(JSON.parse(stdout.pop()).method, 'notifications/progress');
  transport.configureForClient('cline');
  transport.sendLog('error', 'disabled-client message');
  assert.equal(stdout.length, 0);
  assert(stderr.some(line => line.includes('configuration dump')));
} finally {
  transport.cleanup();
  process.stdout.write = originalOut;
  process.stderr.write = originalErr;
}

// Verify the live server handler and ordinary tool calls through real stdio.
const env = createTestEnv();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const connection = new StdioClientTransport({ command: process.execPath,
  args: [path.join(root, 'dist/index.js')], env: env.env, stderr: 'pipe' });
const client = new Client({ name: 'quiet-stdio-regression', version: '1.0.0' });
let notifications = 0;
client.setNotificationHandler(LoggingMessageNotificationSchema, () => { notifications++; });
let diagnostics = '';
connection.stderr?.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-65536); });
try {
  await client.connect(connection);
  const result = await client.callTool({ name: 'get_config', arguments: {} });
  assert.notEqual(result.isError, true);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(notifications, 0, 'initialize and get_config must generate no unsolicited logging notifications');
  await client.request({ method: 'logging/setLevel', params: { level: 'warning' } }, EmptyResultSchema);
  assert(diagnostics.includes('tool_response_size'), 'local scalar telemetry must remain available');
  const metric = diagnostics.split(/\r?\n/).filter(line => line.includes('"tool_response_size"')).map(line => JSON.parse(line)).at(-1);
  assert.equal(metric.tool, 'get_config');
  assert(Number.isFinite(metric.duration_ms));
  assert.equal(typeof metric.process_page_limited, 'boolean');
  assert.equal(metric.is_error, false);
} finally {
  await client.close();
  env.cleanup();
}
console.log('Quiet stdio regression passed: no unsolicited logs, explicit severity opt-in, unchanged tool result and local timing metric.');
