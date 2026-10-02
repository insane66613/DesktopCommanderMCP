import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { TerminalManager, MAX_BUFFERED_OUTPUT_CHARS } from '../dist/terminal-manager.js';
import { runIfMain } from './helpers/run-if-main.js';

export default async function runTests() {
  const manager = new TerminalManager();
  const line = 'a'.repeat(100);
  const count = Math.floor((MAX_BUFFERED_OUTPUT_CHARS + 1) / 101);
  const session = { outputLines: Array(count).fill(line), bufferedChars: count * 101 - 1,
    lastReadIndex: count - 10, lastReadCharacter: 3, evictedLines: 0, evictedChars: 0 };
  const oldCursor = session.lastReadIndex;
  const begin = performance.now();
  manager.appendToLineBuffer(session, '\n' + (line + '\n').repeat(40000));
  const elapsed = performance.now() - begin;
  assert(elapsed < 5000, `bulk eviction must not block the owner for seconds: ${elapsed}ms`);
  assert(session.evictedLines > 0);
  assert(session.bufferedChars <= MAX_BUFFERED_OUTPUT_CHARS);
  assert.equal(session.lastReadIndex, oldCursor - session.evictedLines);
  assert.equal(session.lastReadCharacter, 3, 'retained partial line keeps its character cursor');
  const actualChars = session.outputLines.reduce((size, item) => size + item.length + 1, -1);
  assert.equal(session.bufferedChars, actualChars);
  session.lastReadIndex = 0;
  session.lastReadCharacter = 9;
  manager.appendToLineBuffer(session, (line + '\n').repeat(100));
  assert.equal(session.lastReadCharacter, 0, 'evicted partial line must not skip the next retained line');
  console.log(`Bulk output eviction passed: ${elapsed.toFixed(1)}ms; retained-buffer cursor preserved.`);
}
runIfMain(import.meta.url, runTests);
