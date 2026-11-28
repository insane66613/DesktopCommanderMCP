import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
const dom=new JSDOM('<html><body><div id="app"></div></body></html>',{url:'http://localhost/'});
globalThis.window=dom.window;
globalThis.document=dom.window.document;
globalThis.Node=dom.window.Node;
globalThis.HTMLElement=dom.window.HTMLElement;
const {createConfigEditorController,renderConfigEditor} =
  await import('../dist/ui/config-editor/src/app.js');

const values = { mcpUiPreviewMode:'on',mcpUiPreviewsEnabled:true,
  filePreviewsEnabled:true,showReadFileUI:true,
  showListDirectoryUI:true,showGetConfigUI:false };
const keys=Object.keys(values);
function rows() {
  return keys.map(key=>({
    key,value:values[key],valueType:key==='mcpUiPreviewMode'?'string':'boolean',
    editable:true,
    parentKey:['showReadFileUI','showListDirectoryUI'].includes(key)
      ? 'filePreviewsEnabled':'mcpUiPreviewMode',
    disabledReason:key==='showReadFileUI'||key==='showListDirectoryUI'
      ? (!values.filePreviewsEnabled?'File Previews is off.':undefined) : undefined,
  }));
}
let releaseFirstRefresh;
let firstRefreshStarted;
const waitForFirst=new Promise(resolve=>{firstRefreshStarted=resolve;});
const writes=[];
let refreshes=0;
const tool=async(name,args)=>{
  if(name==='set_config_value'){
    writes.push(args.key);
    values[args.key]=args.value;
    return {content:[{type:'text',text:'saved'}]};
  }
  if(name==='get_config'){
    refreshes++;
    const snapshot=rows(); // Captured now, before overlapping saves.
    if(refreshes===1){
      firstRefreshStarted();
      return new Promise(resolve=>{releaseFirstRefresh=()=>
        resolve({structuredContent:{entries:snapshot}});});
    }
    return {structuredContent:{entries:snapshot}};
  }
  throw new Error('Unexpected tool '+name);
};
const controller=createConfigEditorController(tool);
controller.setPayload({entries:rows()});
const first=controller.apply({key:'filePreviewsEnabled',draftValue:'false'});
await waitForFirst;
assert.deepEqual(writes,['filePreviewsEnabled']);
const second=controller.apply({key:'showReadFileUI',draftValue:'false'});
await Promise.resolve();await Promise.resolve();
assert.deepEqual(writes,['filePreviewsEnabled'],
  'child save must wait until parent write+refresh completes');
controller.setPayload({entries:rows().map(e=>({...e,disabledReason:undefined}))});
releaseFirstRefresh();
assert.equal((await first).ok,true);
assert.equal((await second).ok,true);
assert.deepEqual(writes,['filePreviewsEnabled','showReadFileUI']);
assert.equal(refreshes,2);
let entries=controller.state.payload.entries;
const row=key=>entries.find(e=>e.key===key);
assert.equal(row('showReadFileUI').value,false);
assert.match(row('showReadFileUI').disabledReason,/File Previews is off/);
assert.match(row('showListDirectoryUI').disabledReason,/File Previews is off/);
const container=document.getElementById('app');
renderConfigEditor(container,controller,{hideSummaryRow:false,compact:false,expanded:true});
let input=container.querySelector('[data-setting-key="showReadFileUI"] input');
assert.equal(input.disabled,true);
assert.equal(input.getAttribute('aria-labelledby')!==null,true);
let reason=document.getElementById(input.getAttribute('aria-describedby'));
assert.ok(reason);
assert.match(reason.textContent,/File Previews/);
assert.ok(document.getElementById(input.getAttribute('aria-labelledby')));
assert.equal((await controller.apply({key:'filePreviewsEnabled',draftValue:'true'})).ok,true);
entries=controller.state.payload.entries;
assert.equal(row('showReadFileUI').value,false,'child preference survives');
assert.equal(row('showReadFileUI').disabledReason,undefined);
renderConfigEditor(container,controller,{hideSummaryRow:false,compact:false,expanded:true});
input=container.querySelector('[data-setting-key="showReadFileUI"] input');
assert.equal(input.disabled,false);
assert.equal(input.checked,false);
assert.equal(input.getAttribute('aria-describedby'),null);
console.log('PASS: serialized parent/child saves, stale host refresh, coupled row updates and accessible controls');
dom.window.close();
