import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { searchManager } from '../dist/search-manager.js';
import { handleGetMoreSearchResults } from '../dist/handlers/search-handlers.js';

const id = 'perf-session-' + process.pid;
const count = 50000;
const matches = Array.from({ length: count }, (_, i) => ({
  type: 'file', file: 'X:/fixture/match-' + String(i).padStart(5, '0') + '.txt',
}));

// This is an isolated in-memory search session owned by this test process.
// No managed server session or live production process is touched.
const session = {
  id,
  process: { killed: true, kill: () => false },
  results: matches,
  isComplete: true,
  isError: false,
  startTime: Date.now() - 1500,
  lastReadTime: 1,
  options: { rootPath: 'X:/fixture', pattern: 'match-', searchType: 'files' },
  buffer: '',
  skippedLines: new Map(),
  totalMatches: matches.length,
  totalContextLines: 0,
};
assert.ok(searchManager.sessions instanceof Map, 'SearchManager stores local sessions in a Map');
searchManager.sessions.set(id, session);
try {
  const page = searchManager.readSearchResults(id, 12000, 25);
  assert.deepEqual(page.results, matches.slice(12000, 12025));
  assert.equal(page.returnedCount, 25);
  assert.equal(page.totalResults, count);
  assert.equal(page.hasMoreResults, true);

  session.lastReadTime = 1;
  const tail = searchManager.readSearchResults(id, -3, 3);
  assert.deepEqual(tail.results, matches.slice(-3));
  assert.equal(tail.hasMoreResults, false);
  assert.ok(session.lastReadTime > 1, 'Tail reads must refresh session lifetime');

  const answer = await handleGetMoreSearchResults({
    sessionId: id, offset: count - 3, length: 3,
  });
  assert.notEqual(answer.isError, true);
  const text = answer.content.map(entry => entry.text ?? '').join('\n');
  for (const hit of matches.slice(-3)) {
    assert.ok(text.includes(hit.file), 'User-facing tool answer must contain ' + hit.file);
  }

  const samples = [];
  for (let repeat = 0; repeat < 200; repeat++) {
    const start = performance.now();
    const out = searchManager.readSearchResults(id, count - 20, 20);
    assert.equal(out.returnedCount, 20);
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  console.log(JSON.stringify({
    result: 'PASS', totalMatches: count, calls: 200,
    medianReadMs: Number(samples[100].toFixed(4)),
    meanReadMs: Number((samples.reduce((a, b) => a + b, 0) / samples.length).toFixed(4)),
    userFacingMatches: 3, tailKeepsSessionAlive: true,
  }));
} finally {
  searchManager.sessions.delete(id);
}
