import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createTestEnv } from './helpers/test-env.js';

const env=createTestEnv();
const transport=new StdioClientTransport({
  command:process.execPath,args:[fileURLToPath(new URL('../dist/index.js',import.meta.url))],
  env:env.env,stderr:'pipe'
});
const client=new Client({name:'preview-policy-parity',version:'1.0.0'},{capabilities:{}});
async function set(key,value){
  const r=await client.callTool({name:'set_config_value',arguments:{key,value}});
  assert.notEqual(r.isError,true,'set '+key);
}
async function check(label){
  const r=await client.callTool({name:'get_config',arguments:{verbose:true}});
  assert.notEqual(r.isError,true,label+' config');
  const entries=r.structuredContent?.entries;
  assert.ok(Array.isArray(entries),label+' entries');
  const e=key=>entries.find(row=>row.key===key);
  const global=e('filePreviewsEnabled').disabledReason===undefined;
  const file=global && e('filePreviewsEnabled').value!==false;
  const expected={
    read_file:file && e('showReadFileUI').value!==false,
    list_directory:file && e('showListDirectoryUI').value!==false,
    write_file:file,
    edit_block:file,
    get_config:global && e('showGetConfigUI').value===true,
  };
  const tools=(await client.listTools()).tools;
  for(const [name,wanted] of Object.entries(expected)){
    const tool=tools.find(t=>t.name===name);
    assert.ok(tool,label+' missing '+name);
    assert.equal(Boolean(tool._meta?.ui?.resourceUri),wanted,
      label+' mismatch '+name+' between get_config and tools/list');
  }
  return expected;
}
try{
  await client.connect(transport,{timeout:30000});
  await set('mcpUiPreviewMode','off');
  assert.equal((await check('off')).read_file,false);
  await set('mcpUiPreviewMode','on');
  await set('mcpUiPreviewsEnabled',false);
  assert.equal((await check('on ignores stale legacy false')).read_file,true);
  await set('filePreviewsEnabled',false);
  await set('showGetConfigUI',true);
  const fileOff=await check('file off and config on');
  assert.equal(fileOff.read_file,false);
  assert.equal(fileOff.get_config,true);
  await set('filePreviewsEnabled',true);
  await set('showReadFileUI',false);
  let caseRow=await check('read off, directory on');
  assert.equal(caseRow.read_file,false);
  assert.equal(caseRow.list_directory,true);
  await set('showReadFileUI',true);
  await set('showListDirectoryUI',false);
  caseRow=await check('list off, read on');
  assert.equal(caseRow.list_directory,false);
  assert.equal(caseRow.read_file,true);
  await set('showListDirectoryUI',true);
  await set('mcpUiPreviewMode','auto');
  await check('auto independent from legacy false');
  await set('mcpUiPreviewMode','legacy');
  assert.equal((await check('legacy false')).read_file,false);
  await set('mcpUiPreviewMode','on');
  await set('showGetConfigUI',false);
  assert.equal((await check('config opt-out')).get_config,false);
  console.log('PASS: get_config/tool-list metadata parity across on/off/auto/legacy and child toggles');
} finally {
  await client.close().catch(()=>{});
  env.cleanup();
}
