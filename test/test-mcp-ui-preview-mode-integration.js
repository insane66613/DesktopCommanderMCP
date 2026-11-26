import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { createTestEnv } from './helpers/test-env.js';

const env = createTestEnv();
const serverFile = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverFile],
  env: env.env,
  stderr: 'pipe',
});
const client = new Client({ name:'mcp-ui-preview-policy-test',version:'1.0.0' },
  { capabilities: {} });
let notifications = 0;
client.setNotificationHandler(ToolListChangedNotificationSchema, () => { notifications++; });

async function setSetting(key, value) {
  const result = await client.callTool({ name:'set_config_value', arguments:{key,value} });
  assert.notEqual(result.isError,true, `set_config_value failed ${key}: ${JSON.stringify(result)}`);
}
async function inspectPreview(expected, label) {
  const tools = (await client.listTools()).tools;
  const readFile = tools.find(t=>t.name==='read_file');
  assert(readFile, `${label}: ordinary read_file must remain registered`);
  assert.equal(Boolean(readFile._meta?.['ui/resourceUri']),expected,label);
}
async function main() {
  try {
    await client.connect(transport, { timeout: 30000 });
    assert.equal(client.getServerCapabilities()?.tools?.listChanged,true,
      'Server must negotiate dynamic tool list updates');
    await setSetting('mcpUiPreviewMode','on');
    await inspectPreview(true,'explicit on adds metadata');
    await setSetting('mcpUiPreviewMode','off');
    await inspectPreview(false,'explicit off removes metadata but preserves tool');
    await setSetting('mcpUiPreviewsEnabled',false);
    await setSetting('mcpUiPreviewMode','on');
    await inspectPreview(true,'explicit on beats old false');
    await setSetting('filePreviewsEnabled',false);
    await inspectPreview(false,'explicit per-tool file-preview off still wins globally on');
    await setSetting('filePreviewsEnabled',true);
    await inspectPreview(true,'restoring file-preview toggle restores metadata');
    await setSetting('mcpUiPreviewMode','legacy');
    await inspectPreview(false,'legacy false disables preview');
    await setSetting('mcpUiPreviewMode','auto');
    const beforeNoop = notifications;
    await setSetting('mcpUiPreviewMode','auto');
    assert.equal(notifications,beforeNoop,'no-op mode save must not notify');
    const beforeUnrelated = notifications;
    await setSetting('fileReadLineLimit',1000);
    assert.equal(notifications,beforeUnrelated,'unrelated config save must not notify');
    const configPath = path.join(env.home,'.claude-server-commander','config.json');
    const persisted = JSON.parse(fs.readFileSync(configPath,'utf8'));
    assert.equal(persisted.mcpUiPreviewMode,'auto','new mode persists to disk');
    assert.equal(persisted.mcpUiPreviewsEnabled,false,'legacy field is not clobbered');
    const bad = await client.callTool({ name:'set_config_value',
      arguments:{key:'mcpUiPreviewMode',value:'typo-not-a-mode'} });
    assert.equal(bad.isError,true,'invalid enum must be rejected');
    const reloaded = JSON.parse(fs.readFileSync(configPath,'utf8'));
    assert.equal(reloaded.mcpUiPreviewMode,'auto','invalid edit cannot change durable setting');
    assert(notifications>=5, `expected list-changed notifications, received ${notifications}`);
    console.log(`PASS: dynamic metadata, mode precedence, persistence and notifications=${notifications}`);
  } finally {
    await client.close().catch(()=>{});
    env.cleanup();
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});

