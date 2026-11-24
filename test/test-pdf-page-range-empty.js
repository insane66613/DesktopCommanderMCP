import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { parsePdfToMarkdown } from '../dist/tools/pdf/markdown.js';
import { PdfFileHandler } from '../dist/utils/files/pdf.js';

const sample = fileURLToPath(new URL('./samples/03_sample_compex.pdf', import.meta.url));
const all = await parsePdfToMarkdown(sample);
const count = all.metadata.totalPages;
assert.ok(count >= 2, 'fixture must have multiple pages');
assert.equal(all.pages.length, count, 'default selection must still read all pages');

const beyond = await parsePdfToMarkdown(sample, { offset: count, length: 1 });
assert.equal(beyond.metadata.totalPages, count);
assert.deepEqual(beyond.pages, [], 'out-of-range offset must not return the entire document');

const zero = await parsePdfToMarkdown(sample, { offset: 0, length: 0 });
assert.deepEqual(zero.pages, [], 'explicit zero-length range must remain empty');

const handler = new PdfFileHandler();
const tail = await handler.read(sample, { offset: count - 1 });
assert.equal(tail.metadata?.isPdf, true);
assert.deepEqual(tail.metadata.pages.map(page => page.pageNumber), [count], 'offset without length reads from offset to end');

const negative = await handler.read(sample, { offset: -1 });
assert.deepEqual(negative.metadata.pages.map(page => page.pageNumber), [count], 'negative offset without length reads the tail');

const selected = await parsePdfToMarkdown(sample, { offset: 0, length: 1 });
assert.deepEqual(selected.pages.map(page => page.pageNumber), [1], 'nonempty ranges are unchanged');
console.log('PDF page-range regression passed');
