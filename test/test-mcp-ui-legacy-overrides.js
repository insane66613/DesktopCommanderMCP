import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createTestEnv } from './helpers/test-env.js';

const env=createTestEnv();
const folder=path.join(env.home,'.claude-server-commander');
fs.mkdirSync(folder,{recursive:true});
const configPath=path.join(folder,'config.json');
fs.writeFileSync(configPath,JSON.stringify({
  mcpUiPreviewMode:'on',
  mcpUiPreviewsEnabled:true,
  filePreviewsEnabled:true,
  telemetryEnabled:false,
}));
const file=fileURLToPath(new URL('../dist/index.js',import.meta.url));
const transport=new StdioClientTransport({
  command:process.execPath,args:[file],env:env.env,stderr:'pipe',
});
const client=new Client({name:'mcp-ui-legacy-overrides',version:'1.0.0'},{capabilities:{}});
try {
  await client.connect(transport,{timeout:30000});
  const raw=JSON.parse(fs.readFileSync(configPath,'utf8'));
  assert.equal(raw.showReadFileUI,undefined,'the fixture must represent pre-Wave18 config');
  assert.equal(raw.showListDirectoryUI,undefined,'the fixture must represent pre-Wave18 config');
  const response=await client.callTool({name:'get_config',arguments:{verbose:true}});
  assert.notEqual(response.isError,true,'legacy get_config must succeed');
  const entries=response.structuredContent?.entries??[];
  for(const key of ['showReadFileUI','showListDirectoryUI']) {
    assert.equal(entries.find(item=>item.key===key)?.value,true,
      `${key} must display the inherited true effective setting`);
  }
  let list=(await client.listTools()).tools;
  for(const name of ['read_file','list_directory']) {
    assert(Boolean(list.find(item=>item.name===name)?._meta?.['ui/resourceUri']),
      `${name} widget must work with absent historical override`);
  }
  const disabled=await client.callTool({
    name:'set_config_value',arguments:{key:'showListDirectoryUI',value:false},
  });
  assert.notEqual(disabled.isError,true);
  list=(await client.listTools()).tools;
  assert.equal(Boolean(list.find(item=>item.name==='read_file')?._meta?.['ui/resourceUri']),true);
  assert.equal(Boolean(list.find(item=>item.name==='list_directory')?._meta?.['ui/resourceUri']),false);
  const persisted=JSON.parse(fs.readFileSync(configPath,'utf8'));
  assert.equal(persisted.showListDirectoryUI,false);
  assert.equal(persisted.mcpUiPreviewMode,'on','migration cannot change global policy');
  console.log('PASS: missing historical overrides inherit effective true and remain independently editable');
} finally {
  await client.close().catch(()=>{});
  env.cleanup();
}
