/** Search outcome must reach text, machine result and session listing. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createTestEnv, isTestHome } from './helpers/test-env.js';

async function run() {
  const { searchManager } = await import('../dist/search-manager.js');
  const { handleStartSearch, handleGetMoreSearchResults, handleListSearches } =
    await import('../dist/handlers/search-handlers.js');
  const { enrichStructuredContent } = await import('../dist/structured-content.js');
  const originalStart = searchManager.startSearch;
  let serial = 0;
  function sessionFor({ matches = 0, limit, skipped = false, incomplete = false } = {}) {
    const proc = new EventEmitter();
    proc.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
    proc.stderr = Object.assign(new EventEmitter(), { setEncoding() {} });
    proc.killed = false;
    proc.kill = () => { proc.killed = true; return true; };
    const id = 'outcome-fixture-' + (++serial);
    const session = {
      id, process: proc, isComplete: false, isError: false,
      startTime: Date.now() - 1000, lastReadTime: Date.now(),
      options: { rootPath: 'X:/fixture', pattern: 'test', searchType: 'files', maxResults: limit },
      results: Array.from({ length: matches }, (_, i) =>
        ({ type: 'file', file: 'X:/fixture/hit-' + i })),
      buffer: '', skippedLines: skipped ? new Map([['X:/fixture/long.txt', 1]]) : new Map(),
      totalMatches: matches, totalContextLines: 0, wasIncomplete: incomplete,
    };
    searchManager.sessions.set(id, session);
    searchManager.setupProcessHandlers(session);
    return session;
  }
  async function verify(session, expected) {
    const result = searchManager.readSearchResults(session.id, 0, 50);
    assert.equal(result.outcome, expected, 'manager result outcome');
    assert.equal(result.isComplete, true);
    const answer = await handleGetMoreSearchResults({ sessionId: session.id, offset: 0, length: 50 });
    const text = answer.content.map(b => b.text ?? '').join('');
    assert.match(text, new RegExp('Outcome: ' + expected));
    assert.match(text, new RegExp('Status: ' + expected.toUpperCase()));
    assert(!text.includes('Search completed.') || expected === 'completed',
      'incomplete outcome cannot claim exhaustive completion');
    const machine = enrichStructuredContent('get_more_search_results', answer).structuredContent;
    assert.equal(machine.outcome, expected);
    assert.equal(machine.status, expected.toUpperCase());
    assert.equal(machine.isComplete, true);
    assert.equal(machine.success, expected !== 'failed');
    const listing = await handleListSearches();
    const entries = enrichStructuredContent('list_searches', listing).structuredContent.searches;
    const entry = entries.find(s => s.id === session.id);
    assert.equal(entry?.outcome, expected, 'list_searches must preserve outcome');
  }
  try {
    for (const expected of ['completed', 'max_results', 'partial', 'failed']) {
      const session = sessionFor({
        matches: expected === 'max_results' ? 2 : expected === 'partial' ? 1 : 0,
        limit: expected === 'max_results' ? 2 : undefined,
        incomplete: expected === 'partial',
      });
      session.process.emit('close', expected === 'partial' ? 2 : expected === 'failed' ? 78 : 0);
      await verify(session, expected);
    }
    const stopped = sessionFor({ matches: 1 });
    assert.equal(searchManager.terminateSearch(stopped.id), true);
    assert.equal(searchManager.terminateSearch(stopped.id), false);
    stopped.process.emit('close', null);
    await verify(stopped, 'stopped');
    const timedOut = sessionFor({ matches: 1 });
    timedOut.stopReason = 'timed_out';
    timedOut.process.emit('close', null);
    await verify(timedOut, 'timed_out');
    const unreadable = sessionFor({ matches: 1, skipped: true });
    unreadable.process.emit('close', 0);
    await verify(unreadable, 'partial');
    const malformed = sessionFor();
    malformed.process.stderr.emit('data', 'regex parse error: unclosed group');
    malformed.process.emit('close', 2);
    await verify(malformed, 'failed');
    const errorRace = sessionFor({ matches: 1 });
    errorRace.process.emit('error', new Error('transport fail'));
    errorRace.process.emit('close', 0);
    await verify(errorRace, 'failed');
    searchManager.startSearch = async () => ({
      sessionId: stopped.id, isComplete: true, isError: false,
      outcome: 'stopped', results: [], totalResults: 1, runtime: 10,
    });
    const start = await handleStartSearch({
      path: 'X:/fixture', pattern: 'test', searchType: 'files',
    });
    const startFields = enrichStructuredContent('start_search', start).structuredContent;
    assert.equal(startFields.outcome, 'stopped');
    assert.equal(startFields.isComplete, true);
    console.log('PASS: outcome classification and all three machine-readable search surfaces');
  } finally {
    searchManager.startSearch = originalStart;
    searchManager.dispose();
  }
}
if (!isTestHome()) {
  const isolated = createTestEnv();
  try {
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      env: isolated.env, stdio: 'inherit', timeout: 30000,
    });
    assert.equal(result.status, 0, result.error?.message || 'search outcome test failed');
  } finally {
    isolated.cleanup();
  }
} else {
  await run();
}
