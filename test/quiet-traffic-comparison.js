import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { createTestEnv } from './helpers/test-env.js';
import { fileURLToPath } from 'node:url';

// Explicit two-call experiment, not a background monitor or normal-usage sample.
async function measure(entry) {
  const env = createTestEnv();
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry], env: env.env, stderr: 'pipe' });
  const client = new Client({ name: 'quiet-traffic-comparison', version: '1.0.0' });
  let notifications = 0, notificationBytes = 0;
  client.setNotificationHandler(LoggingMessageNotificationSchema, notification => {
    notifications++;
    notificationBytes += Buffer.byteLength(JSON.stringify(notification), 'utf8');
  });
  transport.stderr?.on('data', () => {});
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: 'get_config', arguments: {} });
    await new Promise(resolve => setTimeout(resolve, 100));
    return { toolCalls: 1, successful: result.isError !== true, loggingNotifications: notifications,
      loggingNotificationBytes: notificationBytes, toolResultBytes: Buffer.byteLength(JSON.stringify(result), 'utf8') };
  } finally { await client.close(); env.cleanup(); }
}
if (!process.argv[2]) throw new Error('Usage: node test/quiet-traffic-comparison.js <baseline dist/index.js>');
console.log(JSON.stringify({ baseline: await measure(process.argv[2]),
  candidate: await measure(fileURLToPath(new URL('../dist/index.js', import.meta.url))) }, null, 2));
