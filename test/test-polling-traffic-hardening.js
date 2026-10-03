import assert from 'assert';
import { fileURLToPath } from 'url';
import { runIfMain } from './helpers/run-if-main.js';
import { terminalManager } from '../dist/terminal-manager.js';
import { startProcess, readProcessOutput, clearPollingState } from '../dist/tools/improved-process-tools.js';

const PROCESS_FIXTURE = fileURLToPath(new URL('./samples/process-output-fixture.js', import.meta.url));
const TEST_SHELL = process.platform === 'win32' ? 'cmd.exe' : undefined;

function getSerializedMcpBytes(result) {
  const envelope = {
    jsonrpc: '2.0',
    id: 1,
    result,
  };
  return Buffer.byteLength(JSON.stringify(envelope), 'utf8');
}

function extractPid(result) {
  if (result.structuredContent?.pid) {
    return result.structuredContent.pid;
  }
  const match = result.content?.[0]?.text?.match(/PID (\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

let launchCounter = 1;

async function launchProcess(argsStr) {
  const startResult = await startProcess({
    command: `node "${PROCESS_FIXTURE}" ${argsStr} dummy_${launchCounter++}`,
    shell: TEST_SHELL,
    timeout_ms: 50,
  });
  const pid = extractPid(startResult);
  assert(pid && pid > 0, `startProcess failed to return PID: ${JSON.stringify(startResult)}`);
  return pid;
}

/**
 * Test 1: Consecutive empty polls return the lightweight receipt (< 250 wire bytes).
 */
async function testConsecutiveEmptyPollsReturnLightweightReceipt() {
  console.log('📋 Test 1: Consecutive empty polls return lightweight receipt...');
  clearPollingState();

  // Runs for 10 seconds without outputting anything
  const pid = await launchProcess('ticks 10000 1');

  try {
    // First poll: process running, no output produced yet.
    // Expect standard empty response (not suppressed on first empty poll).
    const poll1 = await readProcessOutput({ pid, offset: 0, timeout_ms: 50 });
    assert(!poll1.isError, 'Poll 1 should succeed');
    assert.strictEqual(poll1.structuredContent.isFinished, false);
    assert.strictEqual(poll1.structuredContent.exitCode, null);
    assert.match(poll1.content[0].text, /Reading 0 new lines/);
    const wireBytes1 = getSerializedMcpBytes(poll1);
    console.log(`  Initial empty poll wire bytes: ${wireBytes1} bytes`);

    // Second poll within temporal window (< 500ms):
    // Expect compact lightweight receipt!
    const poll2 = await readProcessOutput({ pid, offset: 0, timeout_ms: 50 });
    assert(!poll2.isError, 'Poll 2 should succeed');
    assert.strictEqual(poll2.content[0].text, 'No new output. Process running.');
    assert.deepStrictEqual(poll2.structuredContent, {
      pid,
      text: 'No new output',
      success: true,
      isFinished: false,
      exitCode: null,
      nextOffset: poll1.structuredContent.nextOffset,
      nextCharacterOffset: poll1.structuredContent.nextCharacterOffset,
      hasMoreOutput: false,
      sizeLimited: false,
    });
    const wireBytes2 = getSerializedMcpBytes(poll2);
    console.log(`  Consecutive empty poll wire bytes: ${wireBytes2} bytes`);
    assert(wireBytes2 <= 300, `Lightweight receipt wire bytes (${wireBytes2}) must be <= 300 bytes`);
    assert(wireBytes2 < wireBytes1, `Lightweight receipt should be smaller than initial poll (${wireBytes2} vs ${wireBytes1})`);

    // Third poll: should continue returning lightweight receipt
    const poll3 = await readProcessOutput({ pid, offset: 0, timeout_ms: 50 });
    assert.strictEqual(poll3.content[0].text, 'No new output. Process running.');
    assert.strictEqual(poll3.structuredContent.text, 'No new output');

    console.log('✅ Test 1 passed: Consecutive empty polls return lightweight receipt');
  } finally {
    terminalManager.forceTerminate(pid);
  }
}

/**
 * Test 2: New process output immediately bypasses receipt and returns new text without delay.
 */
async function testNewOutputBypassesReceiptImmediately() {
  console.log('📋 Test 2: New process output immediately bypasses receipt and returns new text...');
  clearPollingState();

  // Emits tick0 at ~400ms, tick1 at ~800ms, etc.
  const pid = await launchProcess('ticks 400 5');

  try {
    // Establish consecutive empty state before first tick arrives
    await readProcessOutput({ pid, offset: 0, timeout_ms: 50 });
    const emptyReceipt = await readProcessOutput({ pid, offset: 0, timeout_ms: 50 });
    assert.strictEqual(emptyReceipt.content[0].text, 'No new output. Process running.');

    // Wait for the new output (timeout up to 1500ms)
    const outputResult = await readProcessOutput({ pid, offset: 0, timeout_ms: 1500 });
    assert(!outputResult.isError, 'Read with output should succeed');
    assert.notStrictEqual(outputResult.content[0].text, 'No new output. Process running.');
    assert.match(outputResult.content[0].text, /tick0/);
    assert.strictEqual(outputResult.structuredContent.isFinished, false);
    assert.match(outputResult.structuredContent.text, /read \d+ lines/);
    console.log('  New output arrived and immediately bypassed lightweight receipt');

    console.log('✅ Test 2 passed: New output immediately delivered without delay');
  } finally {
    terminalManager.forceTerminate(pid);
  }
}

/**
 * Test 3: Process termination immediately returns exitCode.
 */
async function testProcessTerminationReturnsExitCodeImmediately() {
  console.log('📋 Test 3: Process termination immediately returns exitCode...');
  clearPollingState();

  // Waits 400ms, prints 'process_done', then exits
  const pid = await launchProcess('delayed 400 process_done');

  try {
    // Establish consecutive empty state
    await readProcessOutput({ pid, offset: 0, timeout_ms: 50 });
    const receipt = await readProcessOutput({ pid, offset: 0, timeout_ms: 50 });
    assert.strictEqual(receipt.content[0].text, 'No new output. Process running.');

    // Wait for process exit (timeout up to 1500ms)
    const exitResult = await readProcessOutput({ pid, offset: 0, timeout_ms: 1500 });
    assert(!exitResult.isError, 'Read after exit should succeed');
    assert.strictEqual(exitResult.structuredContent.isFinished, true);
    assert.strictEqual(exitResult.structuredContent.exitCode, 0);
    assert.match(exitResult.content[0].text, /Process completed with exit code 0/);
    assert.notStrictEqual(exitResult.content[0].text, 'No new output. Process running.');

    // Subsequent read on completed process also returns complete state
    const afterExit = await readProcessOutput({ pid, offset: 0, timeout_ms: 50 });
    assert.strictEqual(afterExit.structuredContent.isFinished, true);
    assert.strictEqual(afterExit.structuredContent.exitCode, 0);

    console.log('✅ Test 3 passed: Process termination immediately returns exitCode');
  } finally {
    terminalManager.forceTerminate(pid);
  }
}

/**
 * Test 4: offset=0 never replays stale output across calls.
 */
async function testOffsetZeroNeverReplaysStaleOutput() {
  console.log('📋 Test 4: offset=0 never replays stale output across calls...');
  clearPollingState();

  // Emits ticks every 150ms
  const pid = await launchProcess('ticks 150 4');

  try {
    // Read first chunk
    const read1 = await readProcessOutput({ pid, offset: 0, timeout_ms: 300 });
    assert.match(read1.content[0].text, /tick0/);

    // Read second chunk
    const read2 = await readProcessOutput({ pid, offset: 0, timeout_ms: 300 });
    assert.match(read2.content[0].text, /tick1/);
    assert(!read2.content[0].text.includes('tick0'), 'read2 must NOT replay tick0');

    // Wait for remaining ticks to finish
    await new Promise(r => setTimeout(r, 400));
    const read3 = await readProcessOutput({ pid, offset: 0, timeout_ms: 300 });
    assert(!read3.content[0].text.includes('tick0'), 'read3 must NOT replay tick0');
    assert(!read3.content[0].text.includes('tick1'), 'read3 must NOT replay tick1');

    // Read fourth chunk (all drained, process finished or empty)
    const read4 = await readProcessOutput({ pid, offset: 0, timeout_ms: 50 });
    assert(!read4.content[0].text.includes('tick0'), 'read4 must NOT replay tick0');
    assert(!read4.content[0].text.includes('tick1'), 'read4 must NOT replay tick1');

    console.log('✅ Test 4 passed: offset=0 never replays stale output across calls');
  } finally {
    terminalManager.forceTerminate(pid);
  }
}

/**
 * Test 5: Concurrent in-flight requests coalesce safely.
 */
async function testConcurrentInFlightRequestsCoalesceSafely() {
  console.log('📋 Test 5: Concurrent in-flight requests coalesce safely...');
  clearPollingState();

  const pid = await launchProcess('ticks 200 4');

  try {
    // Launch two concurrent requests sharing identical state version & arguments
    const [c1, c2] = await Promise.all([
      readProcessOutput({ pid, offset: 0, timeout_ms: 1000 }),
      readProcessOutput({ pid, offset: 0, timeout_ms: 1000 }),
    ]);

    assert(!c1.isError && !c2.isError, 'Both concurrent calls should succeed');
    assert.match(c1.content[0].text, /tick0/, 'Caller 1 must receive output');
    assert.match(c2.content[0].text, /tick0/, 'Caller 2 must receive output');
    assert.strictEqual(c1.structuredContent.nextOffset, c2.structuredContent.nextOffset);

    // Next sequential read after resolution must NOT replay tick0
    const c3 = await readProcessOutput({ pid, offset: 0, timeout_ms: 50 });
    assert(!c3.content[0].text.includes('tick0'), 'Sequential read after settlement must not replay output');

    console.log('✅ Test 5 passed: Concurrent in-flight requests coalesce safely without race conditions');
  } finally {
    terminalManager.forceTerminate(pid);
  }
}

/**
 * Test 6: Non-consecutive empty polls (> 500ms delay) reset and return standard format before receipt.
 */
async function testTemporalWindowReset() {
  console.log('📋 Test 6: Non-consecutive empty polls reset temporal window...');
  clearPollingState();

  const pid = await launchProcess('ticks 10000 1');

  try {
    // Initial empty poll
    const p1 = await readProcessOutput({ pid, offset: 0, timeout_ms: 50 });
    assert.match(p1.content[0].text, /Reading 0 new lines/);

    // Wait > 650ms (exceeding EMPTY_POLL_WINDOW_MS = 500ms)
    await new Promise(r => setTimeout(r, 650));

    // Delayed poll: should NOT be treated as a tight-loop consecutive poll
    const p2 = await readProcessOutput({ pid, offset: 0, timeout_ms: 50 });
    assert.match(p2.content[0].text, /Reading 0 new lines/, 'Delayed poll should return standard response');
    assert.notStrictEqual(p2.content[0].text, 'No new output. Process running.');

    // Immediate next poll (< 50ms): should now be consecutive and return receipt
    const p3 = await readProcessOutput({ pid, offset: 0, timeout_ms: 50 });
    assert.strictEqual(p3.content[0].text, 'No new output. Process running.');

    console.log('✅ Test 6 passed: Temporal window reset operates correctly');
  } finally {
    terminalManager.forceTerminate(pid);
  }
}

/**
 * Test 7: Absolute read (offset > 0) and tail read (offset < 0) bypass polling suppression.
 */
async function testAbsoluteAndTailReadsBypassSuppression() {
  console.log('📋 Test 7: Absolute and tail reads bypass polling suppression...');
  clearPollingState();

  const pid = await launchProcess('ticks 10000 1');

  try {
    // Absolute read beyond buffer
    const abs1 = await readProcessOutput({ pid, offset: 10, timeout_ms: 50 });
    assert.match(abs1.content[0].text, /Reading 0 lines from line 10/);
    const abs2 = await readProcessOutput({ pid, offset: 10, timeout_ms: 50 });
    assert.match(abs2.content[0].text, /Reading 0 lines from line 10/);
    assert.notStrictEqual(abs2.content[0].text, 'No new output. Process running.');

    // Tail read
    const tail1 = await readProcessOutput({ pid, offset: -5, timeout_ms: 50 });
    assert.match(tail1.content[0].text, /Reading last 0 lines/);
    const tail2 = await readProcessOutput({ pid, offset: -5, timeout_ms: 50 });
    assert.match(tail2.content[0].text, /Reading last 0 lines/);
    assert.notStrictEqual(tail2.content[0].text, 'No new output. Process running.');

    console.log('✅ Test 7 passed: Non-polling offset reads bypass suppression');
  } finally {
    terminalManager.forceTerminate(pid);
  }
}

async function runTests() {
  console.log('🚀 Running Polling Traffic Hardening Acceptance Tests (Milestone 4)...\n');
  try {
    await testConsecutiveEmptyPollsReturnLightweightReceipt();
    await testNewOutputBypassesReceiptImmediately();
    await testProcessTerminationReturnsExitCodeImmediately();
    await testOffsetZeroNeverReplaysStaleOutput();
    await testConcurrentInFlightRequestsCoalesceSafely();
    await testTemporalWindowReset();
    await testAbsoluteAndTailReadsBypassSuppression();

    console.log('\n🎉 ALL POLLING TRAFFIC HARDENING ACCEPTANCE TESTS PASSED (100%)!');
  } catch (error) {
    console.error('\n❌ TEST FAILURE:', error);
    process.exit(1);
  }
}

runIfMain(import.meta.url, runTests);
export { runTests };
