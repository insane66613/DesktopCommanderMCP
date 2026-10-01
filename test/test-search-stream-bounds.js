import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { SearchManager } from '../dist/search-manager.js';
import { runIfMain } from './helpers/run-if-main.js';

async function runTests() {
  const manager = new SearchManager();
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const session = {
    id: 'stream-regression', process: child, results: [], isComplete: false,
    isError: false, startTime: Date.now(), lastReadTime: Date.now(),
    options: { rootPath: '.', pattern: 'needle', searchType: 'content' },
    buffer: '', totalMatches: 0, totalContextLines: 0,
  };
  manager.setupProcessHandlers(session);
  const match = 'needle é€中😀';
  const file = 'naïve-€-中.txt';
  const message = Buffer.from(JSON.stringify({
    type: 'match', data: {
      path: { text: file }, lines: { text: `${match}\n` }, line_number: 1,
      submatches: [{ match: { text: match }, start: 0, end: Buffer.byteLength(match) }],
    },
  }) + '\n');
  // Every byte is a separate pipe chunk, including inside multibyte characters.
  for (const byte of message) child.stdout.write(Buffer.from([byte]));
  assert.equal(session.results.length, 1);
  assert.equal(session.results[0].file, file);
  assert.equal(session.results[0].match, match);
  const error = Buffer.from('search failed: é€中😀\n');
  for (const byte of error) child.stderr.write(Buffer.from([byte]));
  assert.equal(session.error, error.toString(), 'error output must be decoded and stored once');
  child.stderr.write('x'.repeat(256 * 1024));
  assert.equal(session.error.length, 64 * 1024);
  assert.ok(session.error.startsWith(error.toString()));
  child.stdout.end();
  child.stderr.end();
  console.log('Search output preserves split UTF-8; stderr retained once with a 64KiB cap.');
}

runIfMain(import.meta.url, runTests);
