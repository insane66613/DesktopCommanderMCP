/** Deterministic restart pacing acceptance: growth, cap, no stampede and reset. */
import assert from 'node:assert/strict';
import { DesktopCommanderIntegration } from '../dist/remote-device/desktop-commander-integration.js';

process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY='1';
const integration=new DesktopCommanderIntegration();
const oldNow=Date.now;
const oldRandom=Math.random;
const oldLog=console.log;
let now=1_000_000;
let attempts=0;
let fail=true;
Date.now=()=>now;
Math.random=()=>0.5; // remove random jitter to measure the policy itself
console.log=()=>{};   // expected restart failures are intentional
try {
  integration.initialize=async()=>{
    attempts++;
    if(fail)throw new Error('synthetic broken local stdio');
    integration.isReady=true;
    integration.mcpClient={close:async()=>{}};
  };
  const delays=[500,1000,2000,4000,5000,5000];
  for(let i=0;i<delays.length;i++){
    await assert.rejects(()=>integration.ensureReady(),/synthetic broken local stdio/);
    assert.equal(integration.restartAttempts,i+1,'failure count must increase');
    assert.equal(integration.msUntilRestartAllowed,delays[i],
      'exponential backoff should escalate, saturate at 5 seconds, and remain bounded');
    await assert.rejects(()=>integration.ensureReady(),/next attempt in/,
      'a call during backoff must not spawn another child');
    assert.equal(attempts,i+1,'backoff must prevent repeated spawn amplification');
    now+=delays[i];
  }
  fail=false;
  await integration.ensureReady();
  assert.equal(attempts,delays.length+1,'next attempt after cap should run');
  assert.equal(integration.ready,true,'recovered local child is ready');
  assert.equal(integration.restartAttempts,0,'successful restart resets failure counter');
  assert.equal(integration.msUntilRestartAllowed,0,'successful restart clears delay');
  integration.mcpClient=null;
  integration.isReady=false;
  fail=true;
  await assert.rejects(()=>integration.ensureReady(),/synthetic broken local stdio/);
  assert.equal(integration.msUntilRestartAllowed,500,
    'after recovery first failure starts the backoff at 500ms again');
} finally {
  Date.now=oldNow;
  Math.random=oldRandom;
  console.log=oldLog;
}
console.log('PASS: 500/1000/2000/4000/5000ms escalating capped backoff, single restart per window, success reset');

