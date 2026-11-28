import assert from 'node:assert/strict';
import { createConfigEditorController } from '../dist/ui/config-editor/src/app.js';

for (const failureMode of ['mcp-isError','transport-throw','invalid-response',
  'missing-key','duplicate-key','partial-policy','stale-value']) {
  let serverValue=true;
  let releaseRefresh;
  let notifyStarted;
  let refreshCalls=0;
  const writes=[];
  const firstRefreshStarted=new Promise(resolve=>{notifyStarted=resolve;});
  const policyKeys=['filePreviewsEnabled','showReadFileUI','showListDirectoryUI',
    'showGetConfigUI','mcpUiPreviewsEnabled','mcpUiPreviewMode'];
  const makeEntry=(key='filePreviewsEnabled')=>({
    key,value:key==='filePreviewsEnabled'?serverValue:(key==='mcpUiPreviewMode'?'on':true),
    valueType:key==='mcpUiPreviewMode'?'string':'boolean',editable:true,
    parentKey:key==='filePreviewsEnabled'?'mcpUiPreviewMode':undefined
  });
  const fullEntries=()=>policyKeys.map(key=>makeEntry(key));
  const tool=async(name,args)=>{
    if(name==='set_config_value'){
      writes.push(args.value);
      serverValue=args.value;
      return {content:[{type:'text',text:'saved'}]};
    }
    if(name==='get_config'){
      refreshCalls++;
      if(refreshCalls===1){
        notifyStarted();
        return new Promise(resolve=>{releaseRefresh=resolve;});
      }
      return {structuredContent:{entries:fullEntries()}};
    }
    throw new Error('Unexpected tool '+name);
  };
  const c=createConfigEditorController(tool);
  c.setPayload({entries:[{...makeEntry(),value:true}]});
  const first=c.apply({key:'filePreviewsEnabled',draftValue:'false'});
  await firstRefreshStarted;
  assert.deepEqual(writes,[false],failureMode+' first durable write');
  const second=c.apply({key:'filePreviewsEnabled',draftValue:'true'});
  await Promise.resolve();await Promise.resolve();
  assert.deepEqual(writes,[false],failureMode+' second save must queue');
  if(failureMode==='mcp-isError'){
    releaseRefresh({isError:true,content:[{type:'text',text:'refresh failed'}]});
  }else if(failureMode==='transport-throw'){
    releaseRefresh(Promise.reject(new Error('transport disconnected')));
  }else if(failureMode==='missing-key'){
    releaseRefresh({structuredContent:{entries:fullEntries().filter(e=>e.key!=='filePreviewsEnabled')}});
  }else if(failureMode==='duplicate-key'){
    releaseRefresh({structuredContent:{entries:[...fullEntries(),makeEntry()]}});
  }else if(failureMode==='partial-policy'){
    releaseRefresh({structuredContent:{entries:[makeEntry()]}});
  }else if(failureMode==='stale-value'){
    releaseRefresh({structuredContent:{entries:fullEntries().map(e=>e.key==='filePreviewsEnabled'?{...e,value:true}:e)}});
  }else{
    releaseRefresh({content:[{type:'text',text:'unexpected payload'}]});
  }
  const prior=await first;
  assert.equal(prior.ok,false,failureMode+' refresh failure');
  const next=await second;
  assert.equal(next.ok,true,failureMode+' later user request must succeed');
  assert.deepEqual(writes,[false,true],
    failureMode+' later request must not be suppressed by stale local true');
  assert.equal(serverValue,true,failureMode+' remote must match newest user intent');
  assert.equal(c.state.payload.entries[0].value,true,
    failureMode+' UI must reconcile on successful second refresh');
  assert.equal(refreshCalls,2);
}
console.log('PASS: acknowledged write + failed refresh never suppresses later policy save');
