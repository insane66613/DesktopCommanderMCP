/** Exact, faster large-file deep reads: mixed line endings, UTF-8, cancellation and handles. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TextFileHandler } from '../dist/utils/files/text.js';
import { runIfMain } from './helpers/run-if-main.js';

const LARGE = 'x'.repeat(11 * 1024 * 1024);
const handler = new TextFileHandler();

async function check(file, offset, expected, count = 2) {
  const result = await handler.read(file, {
    offset, length: count, includeStatusMessage: true,
  });
  assert.match(result.content, new RegExp('^\\[Reading ' + count + ' lines from line ' + offset + '\\]'));
  const body = result.content.split('\n\n')[1] ?? '';
  assert.equal(body.split('\n')[0], expected, `line ${offset} on ${path.basename(file)}`);
}

export default async function runTests() {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-exact-scan-'));
  try {
    const mixed = path.join(folder, 'mixed.txt');
    const lines = Array.from({ length: 1600 }, (_, i) =>
      `record ${i} π${'λ'.repeat(i % 27)} ${'z'.repeat((i * 19) % 317)}`);
    const separators = ['\r\n', '\n', '\r'];
    const text = lines.map((line, i) => line + separators[i % 3]).join('') + LARGE;
    await fs.writeFile(mixed, text);
    assert.ok((await fs.stat(mixed)).size > 10 * 1024 * 1024);
    await check(mixed, 1000, lines[1000]);
    await check(mixed, 1201, lines[1201]);
    // Legacy schemas admit fractions. Until schema migration, preserve
    // readline's ceil-to-next-line behavior instead of returning false EOF.
    const fraction = await handler.read(mixed, { offset: 1200.5, length: 1, includeStatusMessage: false });
    assert.equal(fraction.content, lines[1201]);
    await check(mixed, 1599, lines[1599]);
    await check(mixed, 1600, LARGE, 1);
    // The read must release both the scanner's FileHandle and its ReadStream.
    const renamed = path.join(folder, 'renamed.txt');
    await fs.rename(mixed, renamed);
    await fs.rename(renamed, mixed);

    const split = path.join(folder, 'split.txt');
    const prefix = 'p\n'.repeat(999);
    const untilBoundary = 'q'.repeat(65535 - Buffer.byteLength(prefix));
    const content = prefix + untilBoundary + '\r\n' + 'BOUNDARY-OK\n' + LARGE;
    assert.equal(Buffer.from(prefix + untilBoundary).length, 65535);
    await fs.writeFile(split, content);
    await check(split, 1000, 'BOUNDARY-OK');

    const noLines = path.join(folder, 'no-delimiters.txt');
    await fs.writeFile(noLines, LARGE);
    const atEof = await handler.read(noLines, { offset: 5000, length: 2, includeStatusMessage: false });
    assert.equal(atEof.content, '');
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      handler.read(split, { offset: 1000, length: 2, signal: controller.signal }),
      (err) => err.name === 'AbortError'
    );

    // Explicitly replace the file after the first read. No retained line
    // index may point into the previous copy, even for equal-sized files.
    const replaced = path.join(folder, 'replaced.txt');
    await fs.writeFile(replaced, text.replace('record 1201', 'record 9201'));
    await fs.rename(replaced, mixed);
    await check(mixed, 1201, lines[1201].replace('record 1201', 'record 9201'));

    console.log('PASS native deep-offset scan: mixed newlines, split CRLF, UTF-8, EOF, abort, replacement, released handles');
    return true;
  } finally {
    await fs.rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
runIfMain(import.meta.url, runTests);
