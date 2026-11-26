/** Regression: remote tool metadata propagates to nested event builders and resets on local calls. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createTestEnv, isTestHome } from './helpers/test-env.js';
if (!isTestHome()) {
  const env=createTestEnv();
  try {
    const child=spawnSync(process.execPath,[import.meta.filename],{
      env:{...env.env,DESKTOP_COMMANDER_DISABLE_TELEMETRY:'1'},
      stdio:'inherit',timeout:45_000,windowsHide:true
    });
    assert.equal(child.status,0,child.error?.message);
  } finally { env.cleanup(); }
} else {
  process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY='1';
  const serverModule=await import('../dist/server.js');
  const { server }=serverModule;
  const { usageTracker }=await import('../dist/utils/usageTracker.js');
  const handler=server._requestHandlers.get('tools/call');
  assert.equal(typeof handler,'function','MCP tools/call request handler exists');
  const original={};
  for(const key of ['trackSuccess','trackFailure','shouldShowOnboarding','shouldPromptForFeedback']){
    original[key]=usageTracker[key];
    usageTracker[key]=async()=>false;
  }
  const call=async(meta)=>{
    const args={method:'tools/call',params:{
      name:'d03_unknown_telemetry_reset_probe',arguments:{},...(meta===undefined?{}:{_meta:meta})
    }};
    const r=await handler(args,{});
    assert.equal(r.isError,true,'unknown fixture tool returns an ordinary error');
  };
  try {
    await call({remote:true,clientInfo:{name:'remote-client-probe',version:'1'}});
    assert.equal(serverModule.currentCallIsRemote,true,'remote=true sets nested telemetry origin');
    assert.equal(serverModule.currentRemoteClient?.name,'remote-client-probe');
    await call(undefined);
    assert.equal(serverModule.currentCallIsRemote,false,'missing _meta resets remote origin');
    assert.equal(serverModule.currentRemoteClient,null,'missing _meta clears remote client');
    await call({remote:false});
    assert.equal(serverModule.currentCallIsRemote,false,'explicit remote:false stays local');
    await call({remote:true});
    assert.equal(serverModule.currentCallIsRemote,true,'subsequent remote call is recognized');
    assert.equal(serverModule.currentRemoteClient?.name,'remote-unknown','missing remote client gets sentinel');
    await call({remote:0});
    assert.equal(serverModule.currentCallIsRemote,false,'falsy remote marker must reset flag');
    assert.equal(serverModule.currentRemoteClient,null);
    const source=fs.readFileSync(new URL('../src/utils/capture.ts',import.meta.url),'utf8');
    const marker='...(currentCallIsRemote ? { remote: String(true) } : {})';
    assert.equal(source.split(marker).length-1,2,
      'both captureBase and buildEventProperties preserve remote attribution with explicit override precedence');
    console.log('PASS remote origin true/false reset, client attribution, both telemetry builder insertions');
  } finally { for(const [key,value] of Object.entries(original))usageTracker[key]=value; }
}
