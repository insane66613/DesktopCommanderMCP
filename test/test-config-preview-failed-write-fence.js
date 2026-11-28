import assert from 'node:assert/strict';
import {createConfigEditorController} from '../dist/ui/config-editor/src/app.js';

const initial = {
  mcpUiPreviewMode: 'on', mcpUiPreviewsEnabled: true,
  filePreviewsEnabled: true, showReadFileUI: true,
  showListDirectoryUI: true, showGetConfigUI: false,
};
const entries = (values) => Object.entries(values).map(([key,value]) => ({
  key, value, valueType: key === 'mcpUiPreviewMode' ? 'string' : 'boolean',
  editable: true,
  parentKey: ['showReadFileUI','showListDirectoryUI'].includes(key)
    ? 'filePreviewsEnabled' : 'mcpUiPreviewMode',
}));
const payload = (values) => ({entries: entries(values)});
for (const failure of ['tool-error', 'rejection']) {
  const server = {...initial};
  const writes = [];
  const call = async (name, args) => {
    if (name === 'set_config_value') {
      writes.push([args.key, args.value]);
      server[args.key] = args.value; // mutation could precede lost acknowledgement
      if (writes.length === 1) {
        if (failure === 'tool-error') {
          return {isError:true,content:[{type:'text',text:'response lost'}]};
        }
        throw new Error('connection ended after dispatch');
      }
      return {content:[{type:'text',text:'saved'}]};
    }
    if (name === 'get_config') return {structuredContent:payload(server)};
    throw new Error('unexpected tool');
  };
  const controller = createConfigEditorController(call);
  controller.setPayload(payload(initial));
  assert.equal((await controller.apply({key:'filePreviewsEnabled',draftValue:'false'})).ok,false);
  assert.equal((await controller.apply({key:'filePreviewsEnabled',draftValue:'true'})).ok,true,
    'uncertain prior write must not suppress corrective write: '+failure);
  assert.deepEqual(writes,[['filePreviewsEnabled',false],['filePreviewsEnabled',true]]);
  assert.equal(server.filePreviewsEnabled,true);
}
console.log('PASS: lost/error set acknowledgement never suppresses corrective policy write');

{
  const server = {...initial};
  const call = async (name,args) => {
    if(name === 'set_config_value') {
      server[args.key]=args.value;
      return {content:[{type:'text',text:'saved'}]};
    }
    if(name === 'get_config') return {structuredContent:payload(server)};
    throw new Error('unexpected tool');
  };
  const controller = createConfigEditorController(call);
  controller.setPayload(payload(initial));
  assert.equal((await controller.apply({key:'filePreviewsEnabled',draftValue:'false'})).ok,true);
  assert.equal(controller.state.payload.entries.find(e=>e.key==='filePreviewsEnabled').value,false);
  controller.setPayload(payload(initial)); // delayed host snapshot, older than saved state
  assert.equal(controller.state.payload.entries.find(e=>e.key==='filePreviewsEnabled').value,false,
    'stale host snapshot must not replace confirmed policy state');
  const conflictingMetadata = payload(server);
  conflictingMetadata.entries.find(e => e.key === 'showReadFileUI').disabledReason = 'outdated host policy';
  controller.setPayload(conflictingMetadata);
  assert.equal(controller.state.payload.entries.find(e=>e.key==='showReadFileUI').disabledReason,
    undefined,'stale host metadata must not override confirmed effective policy');
  controller.setPayload({entries: entries(server).slice(0,5)});
  assert.equal(controller.state.payload.entries.filter(e => Object.hasOwn(initial,e.key)).length,6,
    'partial host snapshot must not discard confirmed policy entries');
}
console.log('PASS: stale or partial host snapshots cannot roll back confirmed preview settings');

{
  const server={...initial};
  const tool=async(name,args)=>{
    if(name==='set_config_value'){
      server[args.key]=args.value;
      return {content:[{type:'text',text:'saved'}]};
    }
    if(name==='get_config') return {structuredContent:{...payload(server),config:{...server}}};
    throw new Error('unexpected tool');
  };
  const controller=createConfigEditorController(tool);
  const partial=payload(initial);
  partial.entries=partial.entries.filter(entry=>entry.key!=='showGetConfigUI');
  partial.config={...initial};
  controller.setPayload(partial);
  assert.equal((await controller.apply({key:'filePreviewsEnabled',draftValue:'false'})).ok,true);
  assert.equal(controller.state.payload.entries.filter(entry=>Object.hasOwn(initial,entry.key)).length,6,
    'successful server refresh must restore all preview controls after partial host snapshot');
  assert.equal(controller.state.payload.config.filePreviewsEnabled,false,
    'summary config must match confirmed editable rows');
}
console.log('PASS: complete policy restoration and coherent configuration snapshot');

{
  const server={...initial};
  let releaseRefresh, notifyRefresh;
  const refreshStarted=new Promise(resolve=>{notifyRefresh=resolve;});
  const tool=async(name,args)=>{
    if(name==='set_config_value'){
      server[args.key]=args.value;
      return {content:[{type:'text',text:'saved'}]};
    }
    if(name==='get_config'){
      notifyRefresh();
      return new Promise(resolve=>{releaseRefresh=()=>
        resolve({structuredContent:payload(server)});});
    }
    throw new Error('unexpected tool');
  };
  const controller=createConfigEditorController(tool);
  controller.setPayload(payload(initial));
  const beforeDispatch=controller.getPreviewReadToken();
  const save=controller.apply({key:'filePreviewsEnabled',draftValue:'false'});
  await refreshStarted;
  const duringWrite=controller.getPreviewReadToken();
  assert.equal(controller.setServerPayloadIfCurrent(payload(initial),beforeDispatch),false,
    'read begun before write dispatch must be rejected');
  releaseRefresh();
  assert.equal((await save).ok,true);
  assert.equal(controller.setServerPayloadIfCurrent(payload(initial),duringWrite),false,
    'read begun after dispatch but before confirmed refresh must be rejected');
  assert.equal(controller.state.payload.entries.find(e=>e.key==='filePreviewsEnabled').value,false);
}
console.log('PASS: pre-dispatch and overlapping server reads cannot overwrite confirmed writes');

{
  const server={...initial};
  const tool=async(name,args)=>{
    if(name==='set_config_value'){
      server[args.key]=args.value;
      return {content:[{type:'text',text:'saved'}]};
    }
    if(name==='get_config') return {structuredContent:{...payload(server),config:{...server}}};
    throw new Error('unexpected tool');
  };
  const controller=createConfigEditorController(tool);
  controller.setPayload({entries:entries(initial),config:{...initial}});
  assert.equal((await controller.apply({key:'filePreviewsEnabled',draftValue:'false'})).ok,true);
  controller.setPayload({entries:entries(initial),config:{...initial}}); // late host response
  const token=controller.getPreviewReadToken();
  const partial={entries:entries(server).slice(0,5),config:{...initial}};
  assert.equal(controller.setServerPayloadIfCurrent(partial,token),false,
    'partial corrective read must not pass the trusted refresh path');
  assert.equal(controller.state.payload.entries.filter(e=>Object.hasOwn(initial,e.key)).length,6);
  assert.equal(controller.state.payload.config.filePreviewsEnabled,false);
  const duplicate={entries:entries(server)};
  duplicate.entries[5]={...duplicate.entries[4]};
  assert.equal(controller.setServerPayloadIfCurrent(duplicate,token),false,
    'duplicate policy key must reject purported authoritative refresh');
  assert.equal(controller.state.payload.entries.filter(e=>Object.hasOwn(initial,e.key)).length,6);
}
console.log('PASS: partial/duplicate corrective server reads preserve confirmed policy and config');
