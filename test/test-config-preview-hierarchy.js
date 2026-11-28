import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createTestEnv } from './helpers/test-env.js';

const env = createTestEnv();
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL('../dist/index.js',import.meta.url))],
  env:env.env,stderr:'pipe',
});
const client = new Client({name:'preview-hierarchy-tests',version:'1.0.0'},{capabilities:{}});
const requiredParents = {
  filePreviewsEnabled:'mcpUiPreviewMode',
  showReadFileUI:'filePreviewsEnabled',
  showListDirectoryUI:'filePreviewsEnabled',
  showGetConfigUI:'mcpUiPreviewMode',
  mcpUiPreviewsEnabled:'mcpUiPreviewMode',
};
async function set(key,value) {
  const response=await client.callTool({name:'set_config_value',arguments:{key,value}});
  assert.notEqual(response.isError,true,'config write '+key);
}
async function getEntries() {
  const r=await client.callTool({name:'get_config',arguments:{verbose:true}});
  assert.notEqual(r.isError,true);
  const entries=r.structuredContent?.entries;
  assert.ok(Array.isArray(entries),'verbose entries missing');
  for(const [key,parent] of Object.entries(requiredParents)) {
    assert.equal(entries.find(x=>x.key===key)?.parentKey,parent,key+' parent');
  }
  return entries;
}
function entry(entries,key){const e=entries.find(x=>x.key===key);assert.ok(e,key);return e;}
const dom = new JSDOM('<html><body><div id="app"></div></body></html>',{url:'http://localhost/'});
globalThis.window=dom.window;
globalThis.document=dom.window.document;
globalThis.Node=dom.window.Node;
globalThis.HTMLElement=dom.window.HTMLElement;
globalThis.KeyboardEvent=dom.window.KeyboardEvent;
const { createConfigEditorController, renderConfigEditor } =
  await import('../dist/ui/config-editor/src/app.js');
const container=document.getElementById('app');
function render(entries) {
  const c=createConfigEditorController(async()=>{throw new Error('not writing through rendered DOM')});
  c.setPayload({entries});
  renderConfigEditor(container,c,{hideSummaryRow:false,compact:false,expanded:true});
}
try {
  await client.connect(transport,{timeout:30000});
  await set('mcpUiPreviewMode','on');
  let entries=await getEntries();
  assert.equal(entry(entries,'showGetConfigUI').value,false);
  assert.equal(entry(entries,'showReadFileUI').disabledReason,undefined);
  render(entries);
  const readRow=container.querySelector('[data-setting-key="showReadFileUI"]');
  assert.ok(readRow?.classList.contains('setting-row--child'));
  assert.equal(readRow.dataset.parentKey,'filePreviewsEnabled');
  assert.equal(readRow.querySelector('input[type="checkbox"]').disabled,false);

  await set('showReadFileUI',false);
  await set('filePreviewsEnabled',false);
  entries=await getEntries();
  assert.match(entry(entries,'showReadFileUI').disabledReason,/File Previews is off/);
  assert.equal(entry(entries,'showReadFileUI').value,false,'disabled child retains choice');
  render(entries);
  const inactive=container.querySelector('[data-setting-key="showReadFileUI"]');
  assert.equal(inactive.querySelector('input[type="checkbox"]').disabled,true);
  assert.match(inactive.querySelector('.setting-disabled-reason').textContent,/File Previews/);
  await set('filePreviewsEnabled',true);
  entries=await getEntries();
  assert.equal(entry(entries,'showReadFileUI').disabledReason,undefined);
  assert.equal(entry(entries,'showReadFileUI').value,false,'re-enable preserves preference');
  await set('mcpUiPreviewMode','off');
  entries=await getEntries();
  assert.match(entry(entries,'filePreviewsEnabled').disabledReason,/MCP UI is currently disabled/);
  assert.match(entry(entries,'showGetConfigUI').disabledReason,/MCP UI is currently disabled/);
  render(entries);
  const configRow=container.querySelector('[data-setting-key="showGetConfigUI"]');
  assert.equal(configRow.querySelector('input[type="checkbox"]').disabled,true);
  assert.ok(configRow.classList.contains('setting-row--disabled'));
  const modeRow=container.querySelector('[data-setting-key="mcpUiPreviewMode"]');
  assert.equal(modeRow.querySelector('select').disabled,false,'parent must remain switchable');
  await set('mcpUiPreviewMode','on');
  await set('mcpUiPreviewsEnabled',false);
  entries=await getEntries();
  assert.match(entry(entries,'mcpUiPreviewsEnabled').disabledReason,/Legacy preview mode/);
  console.log('PASS: exact MCP preview hierarchy, effective disabled state and native accessible controls');
} finally {
  await client.close().catch(()=>{});
  env.cleanup();
  dom.window.close();
}
