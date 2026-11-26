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
const previewToolNames = [
  'read_file', 'write_file', 'receive_file',
  'export_project_file', 'list_directory', 'edit_block',
];
let unrelatedConfigUiUri;
async function inspectPreview(expected, label) {
  const tools = (await client.listTools()).tools;
  for (const name of previewToolNames) {
    const tool = tools.find(t => t.name === name);
    assert(tool, `${label}: ${name} must remain registered`);
    assert.equal(Boolean(tool._meta?.['ui/resourceUri']), expected,
      `${label}: ${name} must follow the current preview setting`);
  }
  const ordinaryTool = tools.find(t => t.name === 'get_file_info');
  assert(ordinaryTool, `${label}: get_file_info must remain available`);
  assert.equal(Boolean(ordinaryTool._meta?.['ui/resourceUri']), false,
    `${label}: preview metadata must not leak to ordinary tools`);
  const configTool = tools.find(t => t.name === 'get_config');
  assert(configTool, `${label}: get_config must remain available`);
  const configUiUri = configTool._meta?.['ui/resourceUri'] ?? null;
  if (unrelatedConfigUiUri === undefined) unrelatedConfigUiUri = configUiUri;
  else assert.equal(configUiUri, unrelatedConfigUiUri,
    `${label}: file-preview AB state must not change unrelated config UI`);
}
async function inspectOverrides(readExpected, directoryExpected, label) {
  const tools = (await client.listTools()).tools;
  const enabled = name => Boolean(tools.find(tool => tool.name === name)?._meta?.['ui/resourceUri']);
  assert.equal(enabled('read_file'), readExpected, `${label}: read_file`);
  assert.equal(enabled('list_directory'), directoryExpected, `${label}: list_directory`);
  for (const name of previewToolNames.filter(name =>
    name !== 'read_file' && name !== 'list_directory')) {
    assert.equal(enabled(name), true, `${label}: unrelated ${name} stays enabled`);
  }
  assert.equal(enabled('get_file_info'), false, `${label}: no metadata leak`);
}
async function main() {
  try {
    await client.connect(transport, { timeout: 30000 });
    const initialConfig = await client.callTool({name:'get_config',arguments:{verbose:true}});
    const initialEntries = initialConfig.structuredContent?.entries ?? [];
    for (const key of ['showReadFileUI','showListDirectoryUI']) {
      assert.equal(initialEntries.find(entry => entry.key === key)?.value,true,
        `${key}: new installs must show the inherited-enabled config switch`);
    }
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
    await setSetting('showReadFileUI',false);
    await inspectOverrides(false,true,'read_file opt-out is independent');
    const exampleFile = path.join(env.home,'preview-normal-result.txt');
    fs.writeFileSync(exampleFile,'preview hidden; ordinary read remains functional');
    const normalRead = await client.callTool({
      name:'read_file', arguments:{path:exampleFile},
    });
    assert.notEqual(normalRead.isError,true,'hiding widget cannot block ordinary read_file');
    assert(normalRead.content.some(item => item.text?.includes('ordinary read')),
      'hiding UI metadata cannot remove ordinary read_file content');
    await setSetting('showListDirectoryUI',false);
    await inspectOverrides(false,false,'both independent opt-outs enabled');
    const normalListing = await client.callTool({
      name:'list_directory',arguments:{path:env.home},
    });
    assert.notEqual(normalListing.isError,true,
      'hiding directory widget cannot block ordinary list_directory');
    assert(normalListing.content.some(item => item.text?.includes('preview-normal-result.txt')),
      'hiding the widget cannot remove ordinary directory listing output');
    await setSetting('showReadFileUI',true);
    await inspectOverrides(true,false,'restoring read_file does not restore list_directory');
    await setSetting('mcpUiPreviewMode','off');
    await inspectPreview(false,'global off beats explicit child true');
    await setSetting('mcpUiPreviewMode','on');
    await inspectOverrides(true,false,'restoring global policy preserves directory opt-out');
    await setSetting('showListDirectoryUI',true);
    await inspectPreview(true,'both child controls restored');
    const beforeChildNoop = notifications;
    await setSetting('showListDirectoryUI',true);
    assert.equal(notifications,beforeChildNoop,'child no-op must not notify');
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
    assert.equal(persisted.showReadFileUI,true,'read file override persists');
    assert.equal(persisted.showListDirectoryUI,true,'directory override persists');
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

