import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { searchFiles } from '../dist/tools/filesystem.js';
import { searchManager } from '../dist/search-manager.js';

const originalStart = searchManager.startSearch;
const originalRead = searchManager.readSearchResults;
const originalTerminate = searchManager.terminateSearch;
const result = (n) => ({ type: 'file', file: 'X:/fixture/match-' + String(n).padStart(4, '0') + '.txt' });

async function scenario({
  total = 265,
  initialCount = 17,
  emptyReads = 0,
  finishedInitially = false,
}) {
  const all = Array.from({ length: total }, (_, i) => result(i));
  const offsets = [];
  let polls = 0;
  let terminated = false;
  searchManager.startSearch = async () => ({
    sessionId: 'test-pagination',
    results: all.slice(0, initialCount),
    isComplete: finishedInitially,
    isError: false,
    totalResults: total,
    runtime: 0,
  });
  searchManager.readSearchResults = (_id, offset = 0, length = 100) => {
    offsets.push(offset);
    polls += 1;
    if (polls <= emptyReads) {
      return { results: [], returnedCount: 0, isComplete: false, hasMoreResults: true };
    }
    const page = all.slice(offset, offset + length);
    return {
      results: page,
      returnedCount: page.length,
      isComplete: true,
      hasMoreResults: offset + length < all.length,
    };
  };
  searchManager.terminateSearch = () => { terminated = true; return true; };
  const started = performance.now();
  try {
    const files = await searchFiles('X:/fixture', 'match-');
    return { files, offsets, elapsedMs: Number((performance.now() - started).toFixed(2)),
      expected: all.map(r => r.file), terminated };
  } finally {
    searchManager.startSearch = originalStart;
    searchManager.readSearchResults = originalRead;
    searchManager.terminateSearch = originalTerminate;
  }
}

try {
  const paginated = await scenario({});
  assert.deepEqual(paginated.files, paginated.expected,
    'Every file must appear once, including all file hits past the first 100');
  assert.equal(paginated.offsets[0], 17,
    'The first poll must begin after initial search results, not offset 0');
  assert.equal(paginated.terminated, false);

  const finished = await scenario({ total: 30, initialCount: 30, finishedInitially: true });
  assert.deepEqual(finished.files, finished.expected);
  assert.deepEqual(finished.offsets, []);

  const delayed = await scenario({ total: 123, initialCount: 9, emptyReads: 1 });
  assert.deepEqual(delayed.files, delayed.expected);
  assert.equal(delayed.offsets[0], 9);
  assert.deepEqual(delayed.offsets.slice(0, 2), [9, 9],
    'An empty poll must not advance the cursor');

  const multiPage = await scenario({ total: 1234, initialCount: 13 });
  assert.deepEqual(multiPage.files, multiPage.expected,
    'Completed sessions must still drain any final pages after the first 1000');
  assert.deepEqual(multiPage.offsets, [13, 1013]);

  console.log(JSON.stringify({
    result: 'PASS', total: paginated.files.length, delayed: delayed.files.length,
    multiPage: multiPage.files.length, offsets: paginated.offsets,
    multiPageOffsets: multiPage.offsets, delayPolls: delayed.offsets,
    firstPageElapsedMs: paginated.elapsedMs,
  }));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
