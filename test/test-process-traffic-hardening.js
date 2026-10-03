import assert from 'assert';
import path from 'path';
import { fileURLToPath } from 'url';
import { runIfMain } from './helpers/run-if-main.js';
import { terminalManager, TerminalManager } from '../dist/terminal-manager.js';
import { startProcess, readProcessOutput } from '../dist/tools/improved-process-tools.js';
import { ReadProcessOutputArgsSchema } from '../dist/tools/schemas.js';
import { MAX_TOOL_RESPONSE_BYTES, DEFAULT_PROCESS_PAGE_BYTES } from '../dist/utils/response-budget.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EMIT_BYTES_SCRIPT = path.join(__dirname, 'benchmarks', 'emit-bytes.cjs');

function getSerializedMcpBytes(result) {
  const envelope = {
    jsonrpc: '2.0',
    id: 1,
    result,
  };
  return Buffer.byteLength(JSON.stringify(envelope), 'utf8');
}

/**
 * Test 1: Default page budget is bounded between 4 KiB and ~8.5 KiB,
 * content[0].text retains full output text, and structuredContent.text is compacted.
 */
async function testDefaultPageBudgetAndCompaction() {
  console.log('📋 Test 1: Default page budget and structured content compaction...');

  const testPid = 88001;
  // 1,000 lines of 100 characters each = ~100 KiB
  const sampleLines = Array.from({ length: 1000 }, (_, i) => `line-${String(i).padStart(4, '0')}-${'X'.repeat(90)}`);

  terminalManager.completedSessions.set(testPid, {
    pid: testPid,
    outputLines: sampleLines,
    exitCode: 0,
    startTime: new Date(),
    endTime: new Date(),
    evictedLines: 0,
    evictedChars: 0,
    lastReadIndex: 0,
    lastReadCharacter: 0,
  });

  const readResult = await readProcessOutput({ pid: testPid, timeout_ms: 0 });
  assert(!readResult.isError, 'read_process_output should succeed');

  // Verify content[0].text contains actual lines of output
  assert(readResult.content?.[0]?.text, 'content[0].text must be present');
  assert(readResult.content[0].text.includes('line-0000'), 'content[0].text must contain output lines');

  // Verify structuredContent.text is concise status receipt
  const sc = readResult.structuredContent;
  assert(sc, 'structuredContent must be present');
  assert.equal(typeof sc.text, 'string', 'structuredContent.text must be a string');
  assert.match(
    sc.text,
    /\[PID \d+: read \d+ lines, \d+ remaining\]/,
    `structuredContent.text must match receipt pattern, got: "${sc.text}"`
  );
  assert(
    !sc.text.includes('XXXXXX'),
    'structuredContent.text must NOT duplicate the verbose output body'
  );
  assert(
    sc.text.length < 120,
    `structuredContent.text must be compact (< 120 chars), got length ${sc.text.length}`
  );

  // Verify total serialized MCP wire bytes is bounded
  const wireBytes = getSerializedMcpBytes(readResult);
  console.log(`  Default page wire bytes: ${wireBytes} bytes (text limit: ${DEFAULT_PROCESS_PAGE_BYTES})`);
  assert(
    wireBytes >= 4096,
    `Wire bytes must be at least 4 KiB for full page, got ${wireBytes}`
  );
  assert(
    wireBytes <= 8900,
    `Wire bytes must not exceed ~8.5 KiB (<= 8,900), got ${wireBytes}`
  );

  // Invariant checks
  assert.equal(sc.isFinished, true, 'isFinished must be true');
  assert.equal(sc.exitCode, 0, 'exitCode must be 0');
  assert.equal(sc.sizeLimited, true, 'sizeLimited must be true for partial page read');
  assert(sc.hasMoreOutput, 'hasMoreOutput must be true when lines remain');

  terminalManager.completedSessions.delete(testPid);
  console.log('✅ Test 1 passed: Default page budget bounded and structuredContent compacted');
}

/**
 * Test 2: Bulk override (maxBytes: 32768) drains up to 32 KiB in a single call.
 */
async function testBulkReadOverride() {
  console.log('📋 Test 2: Deliberate bulk override (maxBytes: 32768)...');

  const testPid = 88002;
  // 1,000 lines of 100 characters each = ~100 KiB
  const sampleLines = Array.from({ length: 1000 }, (_, i) => `bulk-${String(i).padStart(4, '0')}-${'B'.repeat(90)}`);

  terminalManager.completedSessions.set(testPid, {
    pid: testPid,
    outputLines: sampleLines,
    exitCode: 0,
    startTime: new Date(),
    endTime: new Date(),
    evictedLines: 0,
    evictedChars: 0,
    lastReadIndex: 0,
    lastReadCharacter: 0,
  });

  // Call with maxBytes override = 32768
  const bulkResult = await readProcessOutput({
    pid: testPid,
    maxBytes: 32768,
    timeout_ms: 0,
  });
  assert(!bulkResult.isError, 'bulk read should succeed');

  const wireBytes = getSerializedMcpBytes(bulkResult);
  console.log(`  Bulk override wire bytes: ${wireBytes} bytes`);

  // Bulk read should drain substantially more than the default 8 KiB page
  assert(
    wireBytes > 25000,
    `Bulk override wire bytes should drain > 25,000 bytes in a single call, got ${wireBytes}`
  );
  assert(
    wireBytes <= MAX_TOOL_RESPONSE_BYTES + 1024,
    `Bulk override wire bytes should not exceed 33 KiB, got ${wireBytes}`
  );

  // Test pageSize override = 16384
  const testPid2 = 88003;
  terminalManager.completedSessions.set(testPid2, {
    pid: testPid2,
    outputLines: sampleLines,
    exitCode: 0,
    startTime: new Date(),
    endTime: new Date(),
    evictedLines: 0,
    evictedChars: 0,
    lastReadIndex: 0,
    lastReadCharacter: 0,
  });

  const pageSizeResult = await readProcessOutput({
    pid: testPid2,
    pageSize: 16384,
    timeout_ms: 0,
  });
  assert(!pageSizeResult.isError, 'pageSize override read should succeed');

  const pageSizeBytes = getSerializedMcpBytes(pageSizeResult);
  console.log(`  PageSize override wire bytes: ${pageSizeBytes} bytes`);
  assert(
    pageSizeBytes > 12000 && pageSizeBytes <= 17500,
    `PageSize (16 KiB) wire bytes should be between 12 KiB and 17.5 KiB, got ${pageSizeBytes}`
  );

  terminalManager.completedSessions.delete(testPid);
  terminalManager.completedSessions.delete(testPid2);
  console.log('✅ Test 2 passed: Bulk read overrides drain up to configured byte limits');
}

/**
 * Test 3: Pagination cursors advance monotonically and terminate at EOF without truncation.
 */
async function testMonotonicCursorAdvancementAndEOF() {
  console.log('📋 Test 3: Monotonic cursor advancement and lossless EOF termination...');

  const testPid = 88004;
  const lineCount = 350;
  // Unique payload lines with 100 chars each (total ~35 KiB) to require multiple 8 KiB pages
  const originalLines = Array.from(
    { length: lineCount },
    (_, i) => `record-${String(i).padStart(4, '0')}-${'M'.repeat(85)}`
  );

  terminalManager.completedSessions.set(testPid, {
    pid: testPid,
    outputLines: originalLines,
    exitCode: 0,
    startTime: new Date(),
    endTime: new Date(),
    evictedLines: 0,
    evictedChars: 0,
    lastReadIndex: 0,
    lastReadCharacter: 0,
  });

  const stitchedLines = [];
  let currentLine = '';
  let previousOffset = 0;
  let iterations = 0;
  let done = false;

  while (!done && iterations < 50) {
    iterations++;
    const res = terminalManager.readOutputPaginated(testPid, 0, 1000);
    assert(res, `Read iteration ${iterations} returned null`);

    assert(
      res.nextOffset >= previousOffset,
      `Cursor must advance monotonically: nextOffset ${res.nextOffset} < previousOffset ${previousOffset}`
    );
    previousOffset = res.nextOffset;

    for (let i = 0; i < res.lines.length; i++) {
      const piece = res.lines[i];
      if (i === 0 && currentLine.length > 0) currentLine += piece;
      else currentLine = piece;

      if (i === res.lines.length - 1 && res.nextCharacterOffset > 0) {
        // partial line split across budget boundary; continues on next page
      } else {
        stitchedLines.push(currentLine);
        currentLine = '';
      }
    }

    if (!res.sizeLimited && !res.remaining) {
      done = true;
    }
  }

  assert(done, 'Pagination should terminate at EOF');
  assert(
    iterations >= 4,
    `Expected multi-step pagination (>= 4 calls for 35 KiB at 8 KiB pages), got ${iterations} calls`
  );
  assert.equal(
    stitchedLines.length,
    originalLines.length,
    `Must recover exact line count: expected ${originalLines.length}, got ${stitchedLines.length}`
  );
  assert.deepEqual(
    stitchedLines,
    originalLines,
    'Stitched lines must match original sequence exactly with zero truncation or corruption'
  );

  // Subsequent read on completed exhausted stream should return 0 new lines and remaining=0
  const eofRead = await readProcessOutput({ pid: testPid, offset: 0, timeout_ms: 0 });
  assert.equal(eofRead.structuredContent.hasMoreOutput, false, 'hasMoreOutput must be false at EOF');
  assert.equal(eofRead.structuredContent.sizeLimited, false, 'sizeLimited must be false at EOF');

  terminalManager.completedSessions.delete(testPid);
  console.log(`✅ Test 3 passed: Monotonic cursors drained ${lineCount} lines in ${iterations} calls with zero loss`);
}

/**
 * Test 4: Zod schema validation for maxBytes and pageSize.
 */
async function testSchemaValidation() {
  console.log('📋 Test 4: Schema validation for maxBytes and pageSize...');

  // Valid values
  assert(ReadProcessOutputArgsSchema.safeParse({ pid: 1, maxBytes: 1024 }).success);
  assert(ReadProcessOutputArgsSchema.safeParse({ pid: 1, maxBytes: 512 }).success);
  assert(ReadProcessOutputArgsSchema.safeParse({ pid: 1, maxBytes: 32768 }).success);
  assert(ReadProcessOutputArgsSchema.safeParse({ pid: 1, pageSize: 8192 }).success);

  // Boundary rejections
  assert(!ReadProcessOutputArgsSchema.safeParse({ pid: 1, maxBytes: 256 }).success, 'maxBytes < 512 must fail');
  assert(!ReadProcessOutputArgsSchema.safeParse({ pid: 1, maxBytes: 32769 }).success, 'maxBytes > 32768 must fail');
  assert(!ReadProcessOutputArgsSchema.safeParse({ pid: 1, pageSize: 100 }).success, 'pageSize < 512 must fail');
  assert(!ReadProcessOutputArgsSchema.safeParse({ pid: 1, pageSize: 65536 }).success, 'pageSize > 32768 must fail');
  assert(!ReadProcessOutputArgsSchema.safeParse({ pid: 1, maxBytes: 1024.5 }).success, 'non-integer must fail');

  console.log('✅ Test 4 passed: Schema correctly bounds maxBytes and pageSize between 512 and 32768');
}

/**
 * Test 5: Live process output generation, draining, and wire byte bounding.
 */
async function testLiveProcessDrain() {
  console.log('📋 Test 5: Live process execution and drain bounding...');

  // Spawn a real child process emitting ~25 KiB of output using the cross-platform emit-bytes fixture
  const startResult = await startProcess({
    command: `node "${EMIT_BYTES_SCRIPT}" 25000`,
    shell: process.platform === 'win32' ? 'cmd.exe' : undefined,
    timeout_ms: 10000,
  });

  const pid = startResult.structuredContent?.pid ?? (
    startResult.content?.[0]?.text?.match(/PID (\d+)/)
      ? parseInt(startResult.content[0].text.match(/PID (\d+)/)[1], 10)
      : null
  );
  assert(pid, `start_process must return a PID, result was: ${JSON.stringify(startResult)}`);

  // Wait a short moment for node to finish emitting
  await new Promise((r) => setTimeout(r, 1000));

  let totalDrainedBytes = 0;
  let calls = 0;
  let finished = false;

  while (!finished && calls < 20) {
    calls++;
    const res = await readProcessOutput({ pid, timeout_ms: 2000 });
    assert(!res.isError, `Call ${calls} failed`);

    const bytes = getSerializedMcpBytes(res);
    totalDrainedBytes += bytes;

    // Verify wire byte bounding on every page
    assert(
      bytes <= 8900,
      `Each default page wire bytes must remain <= 8,900, got ${bytes}`
    );

    const sc = res.structuredContent;
    if (!sc.sizeLimited && !sc.hasMoreOutput) {
      finished = true;
    }
  }

  assert(finished, 'Live process must finish and drain completely');
  console.log(`  Live process drained in ${calls} calls, total wire bytes: ${totalDrainedBytes} bytes`);
  console.log('✅ Test 5 passed: Live process output drained cleanly with bounded page sizes');
}

async function runAllTests() {
  console.log('🚀 Running Process Traffic Hardening Acceptance Tests...\n');
  try {
    await testDefaultPageBudgetAndCompaction();
    await testBulkReadOverride();
    await testMonotonicCursorAdvancementAndEOF();
    await testSchemaValidation();
    await testLiveProcessDrain();
    console.log('\n🎉 ALL PROCESS TRAFFIC HARDENING ACCEPTANCE TESTS PASSED (100%)!');
    return true;
  } catch (err) {
    console.error('\n❌ Acceptance tests failed:', err);
    return false;
  }
}

runIfMain(import.meta.url, runAllTests);
