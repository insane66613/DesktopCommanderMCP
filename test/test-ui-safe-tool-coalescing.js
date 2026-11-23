import assert from 'node:assert/strict';
import { createToolBridge } from '../dist/ui/shared/tool-bridge.js';
import { runIfMain } from './helpers/run-if-main.js';

async function testIdenticalConcurrentReads() {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const bridge = createToolBridge({ host: { openai: {
    callTool: async (name, args) => { calls++; await gate; return { name, args }; },
  } } });
  const first = bridge.callTool('read_file', { path: 'same.txt', options: { offset: 0 } });
  const second = bridge.callTool('read_file', { options: { offset: 0 }, path: 'same.txt' });
  assert.equal(calls, 1, 'equivalent concurrent reads must share a request');
  release();
  assert.deepEqual(await first, await second);
  await bridge.callTool('read_file', { path: 'same.txt', options: { offset: 0 } });
  assert.equal(calls, 2, 'sequential reads must execute separately');
}

async function testStateChangingCallsStayDistinct() {
  const names = ['write_file', 'edit_block', 'start_process', 'read_process_output',
    'get_more_search_results', 'track_ui_event'];
  for (const name of names) {
    let calls = 0;
    const bridge = createToolBridge({ host: { openai: {
      callTool: async () => ({ call: ++calls }),
    } } });
    const results = await Promise.all([
      bridge.callTool(name, { value: 1 }), bridge.callTool(name, { value: 1 }),
    ]);
    assert.equal(calls, 2, name + ' must not suppress an intentional call');
    assert.notDeepEqual(results[0], results[1], name + ' should retain distinct results');
  }
}

async function testReadAfterWriteInvalidation() {
  let release;
  const heldRead = new Promise((resolve) => { release = resolve; });
  let reads = 0;
  const bridge = createToolBridge({ host: { openai: {
    callTool: async (name) => {
      if (name === 'read_file') {
        const sequence = ++reads;
        if (sequence === 1) await heldRead;
        return { sequence };
      }
      return { wrote: true };
    },
  } } });
  const oldRead = bridge.callTool('read_file', { path: 'state.txt' });
  assert.equal(reads, 1);
  await bridge.callTool('write_file', { path: 'state.txt', mode: 'rewrite', content: 'new' });
  const newRead = bridge.callTool('read_file', { path: 'state.txt' });
  assert.equal(reads, 2, 'read after write must not reuse the pre-write request');
  release();
  assert.deepEqual(await oldRead, { sequence: 1 });
  assert.deepEqual(await newRead, { sequence: 2 });
}

async function main() {
  await testIdenticalConcurrentReads();
  await testStateChangingCallsStayDistinct();
  await testReadAfterWriteInvalidation();
  console.log('PASS: safe read sharing, no mutation suppression, read-after-write');
  return true;
}

runIfMain(import.meta.url, main);
