import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createTestEnv } from './helpers/test-env.js';

const env = createTestEnv();
const transport = new StdioClientTransport({
  command:process.execPath,
  args:[fileURLToPath(new URL('../dist/index.js',import.meta.url))],
  env:env.env, stderr:'pipe'
});
const client = new Client({name:'get-config-widget-optin',version:'1.0.0'},
  {capabilities:{}});
const uri='ui://desktop-commander/config-editor';
const tool=async()=> (await client.listTools()).tools.find(item=>item.name==='get_config');
async function set(key,value) {
  const result=await client.callTool({name:'set_config_value',arguments:{key,value}});
  assert.notEqual(result.isError,true,'set_config_value '+key);
}
try {
  await client.connect(transport,{timeout:30000});
  assert.equal(Boolean((await tool())._meta?.ui?.resourceUri),false,
    'get_config stays plain unless opted in');
  const first=await client.callTool({name:'get_config',arguments:{verbose:true}});
  assert.notEqual(first.isError,true);
  assert.equal(first.structuredContent.entries.find(e=>e.key==='showGetConfigUI')?.value,
    false, 'new installs should expose the default-off config switch');
  await set('mcpUiPreviewMode','on');
  assert.equal(Boolean((await tool())._meta?.ui?.resourceUri),false);
  await set('showGetConfigUI',true);
  assert.equal((await tool())._meta.ui.resourceUri,uri);
  assert.equal((await tool())._meta['ui/resourceUri'],uri);
  const resource=await client.readResource({uri});
  assert.ok(resource.contents.length>0,'config editor resource must exist');
  await set('filePreviewsEnabled',false);
  assert.equal((await tool())._meta.ui.resourceUri,uri,
    'config-editor opt-in must not depend on file-preview setting');
  await set('mcpUiPreviewMode','off');
  assert.equal(Boolean((await tool())._meta?.ui?.resourceUri),false,
    'global off overrides child opt-in');
  await set('mcpUiPreviewMode','on');
  assert.equal((await tool())._meta.ui.resourceUri,uri);
  await set('showGetConfigUI',false);
  assert.equal(Boolean((await tool())._meta?.ui?.resourceUri),false);
  const normal=await client.callTool({name:'get_config',arguments:{verbose:true}});
  assert.notEqual(normal.isError,true,'get_config remains functional when UI off');
  assert.ok(normal.structuredContent?.config,'ordinary config response preserved');
  const configPath=path.join(env.home,'.claude-server-commander','config.json');
  assert.equal(JSON.parse(fs.readFileSync(configPath,'utf8')).showGetConfigUI,false,
    'opt-out must persist durably');
  console.log('PASS: get_config widget opt-in, dynamic list metadata, global/off precedence and readback');
} finally {
  await client.close().catch(()=>{});
  env.cleanup();
}
