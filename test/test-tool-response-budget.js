import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createTestEnv } from './helpers/test-env.js';

if (!process.env.DC_RESPONSE_BUDGET_TEST_CHILD) {
  const env = createTestEnv();
  try {
    const child = spawnSync(process.execPath, [import.meta.filename], {
      env: { ...env.env, DC_RESPONSE_BUDGET_TEST_CHILD: '1' }, stdio: 'inherit', timeout: 30000,
    });
    assert.equal(child.status, 0, 'isolated response budget checks');
  } finally { env.cleanup(); }
} else {
  const { budgetToolResponse, boundedText, serializedBytes, MAX_TOOL_RESPONSE_BYTES, MAX_PROCESS_PAGE_BYTES } = await import('../dist/utils/response-budget.js');
  const { terminalManager, TerminalManager } = await import('../dist/terminal-manager.js');
  const { readProcessOutput } = await import('../dist/tools/improved-process-tools.js');
  const { enrichStructuredContent } = await import('../dist/structured-content.js');
  const { configManager } = await import('../dist/config-manager.js');
  const { usageTracker } = await import('../dist/utils/usageTracker.js');

  const huge = '\\"😀'.repeat(300000);
  const result = budgetToolResponse({ content: [{ type: 'text', text: huge }], structuredContent: {
    text: huge, output: huge, success: true, pid: 123, sessions: [{ text: huge }],
  }, _meta: { huge }, isError: false });
  assert(serializedBytes(result) <= MAX_TOOL_RESPONSE_BYTES);
  assert.equal(result.isError, false, 'successful operations must not become retryable errors');
  assert.equal(result.structuredContent.success, true);
  assert.equal(result.structuredContent.pid, 123);
  assert.equal(result.structuredContent.responseTruncated, true);
  assert.equal(result._meta, undefined);
  const media = budgetToolResponse({ content: [{ type: 'image', data: 'A'.repeat(100000), mimeType: 'image/png' }],
    structuredContent: { encoding: 'base64', content: 'A'.repeat(100000), returnedBytes: 75000, truncated: false, sha256: 'abc', success: true } });
  assert.equal(media.structuredContent.content, undefined, 'never return partial base64');
  assert.equal(media.structuredContent.returnedBytes, 0);
  assert.equal(media.structuredContent.truncated, true);
  assert.equal(media.content[0].type, 'text');
  const textTransfer = budgetToolResponse({ content: [{ type: 'text', text: 'exported' }],
    structuredContent: { encoding: 'utf8', content: huge, returnedBytes: 2000000, truncated: false,
      sha256: 'abc', filePath: 'fixture.txt', offset: 7, success: true } });
  assert.equal(textTransfer.structuredContent.content, undefined);
  assert.equal(textTransfer.structuredContent.returnedBytes, 0);
  assert.equal(textTransfer.structuredContent.truncated, true);
  assert.equal(textTransfer.structuredContent.offset, 7);
  assert.equal(textTransfer.structuredContent.sha256, 'abc');
  assert.equal(budgetToolResponse({ content: [{ type: 'text', text: 'small' }] }).content[0].text, 'small');
  assert(!/[\uD800-\uDBFF]$/.test(boundedText('😀'.repeat(500), 101)));

  const manager = new TerminalManager();
  const longLine = '\\"😀'.repeat(9000);
  manager.completedSessions.set(123, { outputLines: [longLine, 'last'], lastReadIndex: 0,
    exitCode: 0, startTime: new Date(), endTime: new Date(), evictedLines: 0, evictedChars: 0 });
  let reconstructed = '';
  let page;
  let reads = 0;
  do {
    page = manager.readOutputPaginated(123, 0, 1);
    assert(serializedBytes(page.lines.join('\n')) <= MAX_PROCESS_PAGE_BYTES);
    reconstructed += page.lines.join('');
    assert(++reads < 100, 'bounded paging must make progress');
  } while (page.nextOffset === 0);
  assert.equal(reconstructed, longLine, 'long Unicode lines must survive incremental paging exactly');
  assert.deepEqual(manager.readOutputPaginated(123, 0, 1).lines, ['last']);
  assert.deepEqual(manager.readOutputPaginated(123, 0, 1).lines, [], 'completed output must not replay');
  const replay = manager.readOutputPaginated(123, 0, 1, 0);
  assert.equal(replay.nextOffset, 0);
  assert(replay.nextCharacterOffset > 0);
  assert.deepEqual(manager.readOutputPaginated(123, 0, 1).lines, [], 'explicit reads must not move default cursor');

  manager.sessions.set(124, { outputLines: ['abc'], lastReadIndex: 0, startTime: new Date(), evictedLines: 0, evictedChars: 0 });
  assert.deepEqual(manager.readOutputPaginated(124, 0, 1).lines, ['abc']);
  assert.equal(manager.hasUnreadOutput(124), false);
  manager.sessions.get(124).outputLines[0] += 'def';
  assert.equal(manager.hasUnreadOutput(124), true, 'growth within an unfinished line is new output');
  assert.deepEqual(manager.readOutputPaginated(124, 0, 1).lines, ['def']);
  const active = manager.sessions.get(124);
  manager.completedSessions.set(124, { ...active, endTime: new Date(), exitCode: 0 });
  manager.sessions.delete(124);
  assert.equal(manager.readOutputPaginated(124, 0, 1).lines.join(''), '', 'completion retains the consumed character position');
  manager.sessions.set(125, { outputLines: ['x'.repeat(50000)], lastReadIndex: 0, startTime: new Date(), evictedLines: 0, evictedChars: 0 });
  assert(manager.getNewOutput(125).includes('Size-limited output'), 'legacy interactive output must disclose continuation');

  // Reproduce the former ~50 MiB completed-output response without emitting its contents.
  terminalManager.completedSessions.set(456, { outputLines: Array(52).fill('x'.repeat(1024 * 1024)),
    lastReadIndex: 0, exitCode: 0, startTime: new Date(), endTime: new Date(), evictedLines: 0, evictedChars: 0 });
  const first = enrichStructuredContent('read_process_output', await readProcessOutput({ pid: 456, length: 400, timeout_ms: 0 }));
  const second = await readProcessOutput({ pid: 456, length: 400, timeout_ms: 0 });
  assert(serializedBytes(first) <= MAX_TOOL_RESPONSE_BYTES);
  assert(first.structuredContent.nextCharacterOffset > 0);
  assert(second.structuredContent.nextCharacterOffset > first.structuredContent.nextCharacterOffset);
  assert.equal(first.structuredContent.isFinished, true);
  assert.equal(first.structuredContent.sizeLimited, true);

  await configManager.setValue('user_surveys', false);
  assert.equal(await usageTracker.shouldPromptForFeedback(), false);
  console.log(`Response budget regressions passed; former 50 MiB process result now ${serializedBytes(first)} bytes, with lossless cursor continuation.`);
}
