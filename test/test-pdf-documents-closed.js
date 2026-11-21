/**
 * A PDF read owns every document opened by unpdf/pdf2md.
 * Close the loading task even when the PDF.js proxy has no destroy() method,
 * and close the text document if page selection throws after parsing.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { closePdfDocument } from '../dist/tools/pdf/utils.js';
import { extractImagesFromPdf } from '../dist/tools/pdf/extract-images.js';
import { pdf2md } from '../dist/tools/pdf/lib/pdf2md.js';
import { runIfMain } from './helpers/run-if-main.js';

const require = createRequire(import.meta.url);
const sample = fileURLToPath(new URL('./samples/01_sample_simple.pdf', import.meta.url));

async function testTaskFirstClosureAndLegacyFallback() {
  let closed = 0;
  const taskOnly = {
    loadingTask: { async destroy() { closed++; } },
  };
  await closePdfDocument(taskOnly);
  assert.equal(closed, 1, 'document with no destroy() must close its loading task');

  let fallback = 0;
  await closePdfDocument({ async destroy() { fallback++; } });
  assert.equal(fallback, 1, 'legacy document without a loading task must still close');
  await closePdfDocument({ loadingTask: { async destroy() { throw new Error('close failed'); } } });
  console.log('PASS: loading-task first, legacy fallback and non-masking close errors');
}

async function testParseFailureStillClosesDocument() {
  const pdf2mdModule = require('@opendocsg/pdf2md/lib/util/pdf');
  const original = pdf2mdModule.parse;
  let taskDestroyed = 0;
  let cacheCleaned = 0;
  pdf2mdModule.parse = async () => ({
    fonts: { map: new Map() },
    pages: [{ items: [] }],
    metadata: {},
    pdfDocument: {
      async cleanup() { cacheCleaned++; },
      loadingTask: { async destroy() { taskDestroyed++; } },
    },
  });

  try {
    // pdf2md has already opened the document before evaluating this getter.
    await assert.rejects(
      pdf2md(Uint8Array.of(0), {
        get offset() { throw new Error('injected page-range failure'); },
        length: 1,
      }),
      /injected page-range failure/,
    );
    assert.equal(cacheCleaned, 1, 'error path must release page caches');
    assert.equal(taskDestroyed, 1, 'error path must destroy its loading task');

    // A parse-result getter may fail while destructuring. The document's
    // ownership must already be known before those other fields are read.
    let accessorDestroyed = 0;
    pdf2mdModule.parse = async () => ({
      fonts: { map: new Map() },
      get pages() { throw new Error('injected pages getter failure'); },
      pdfDocument: {
        async cleanup() {},
        loadingTask: { async destroy() { accessorDestroyed++; } },
      },
    });
    await assert.rejects(
      pdf2md(Uint8Array.of(0), [1]),
      /injected pages getter failure/,
    );
    assert.equal(accessorDestroyed, 1, 'parse-result property errors must close the document');
  } finally {
    pdf2mdModule.parse = original;
  }
  console.log('PASS: pdf2md closes documents when page selection throws');
}

async function testUnpdfImageProxyClosesLoadingTask() {
  const bytes = fs.readFileSync(sample);
  const { getDocumentProxy } = await import('unpdf');
  const probe = await getDocumentProxy(Uint8Array.from(bytes));
  const prototype = Object.getPrototypeOf(probe);
  const originalGetPage = Object.getOwnPropertyDescriptor(prototype, 'getPage');
  assert.ok(originalGetPage && typeof originalGetPage.value === 'function');
  await probe.loadingTask.destroy();

  const seen = new Map();
  Object.defineProperty(prototype, 'getPage', {
    ...originalGetPage,
    value(...args) {
      if (!seen.has(this)) {
        const task = this.loadingTask;
        const originalDestroy = task.destroy.bind(task);
        let calls = 0;
        task.destroy = async (...parameters) => {
          calls++;
          return originalDestroy(...parameters);
        };
        seen.set(this, () => calls);
      }
      return originalGetPage.value.apply(this, args);
    },
  });
  try {
    await extractImagesFromPdf(Uint8Array.from(bytes), [1]);
    assert.ok(seen.size > 0, 'test must observe at least one image-document page access');
    for (const [document, calls] of seen) {
      assert.equal(calls(), 1, 'each image extraction proxy must destroy loadingTask');
    }
  } finally {
    Object.defineProperty(prototype, 'getPage', originalGetPage);
  }
  console.log('PASS: extracting images closes its unpdf loading task');
}

export default async function runTests() {
  await testTaskFirstClosureAndLegacyFallback();
  await testParseFailureStillClosesDocument();
  await testUnpdfImageProxyClosesLoadingTask();
  console.log('PASS: all PDF document lifecycle regressions');
}

runIfMain(import.meta.url, runTests);
