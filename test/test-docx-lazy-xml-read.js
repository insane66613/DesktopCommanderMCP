import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DocxFileHandler, loadPizZip } from '../dist/utils/files/docx.js';
import { runIfMain } from './helpers/run-if-main.js';

export default async function runTests() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-docx-lazy-xml-'));
  const file = path.join(dir, 'document.docx');
  const handler = new DocxFileHandler();
  const PizZip = loadPizZip();
  const probe = new PizZip();
  probe.file('probe.xml', '');
  const zipObjectPrototype = Object.getPrototypeOf(probe.file('probe.xml'));
  const originalAsText = zipObjectPrototype.asText;
  const readCounts = new Map();

  try {
    await handler.write(file, '# Title\nBody text');
    const zip = new PizZip(fs.readFileSync(file));
    zip.file('customXml/item1.xml', `<root>${'unused '.repeat(64 * 1024)}</root>`);
    fs.writeFileSync(file, zip.generate({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 }
    }));

    zipObjectPrototype.asText = function () {
      readCounts.set(this.name, (readCounts.get(this.name) || 0) + 1);
      return originalAsText.call(this);
    };

    const result = await handler.read(file);
    assert.strictEqual(result.metadata?.isDocx, true);
    assert(result.content.includes('Title'));
    assert.strictEqual(readCounts.get('word/document.xml'), 1,
      'read should decode the document XML only once');
    assert.strictEqual(readCounts.get('customXml/item1.xml') || 0, 0,
      'read should not decompress unrelated custom XML parts');

    readCounts.clear();
    const info = await handler.getInfo(file);
    assert.strictEqual(info.fileType, 'docx');
    assert.strictEqual(readCounts.get('word/document.xml'), 1,
      'getInfo should decode the document XML only once');
    assert.strictEqual(readCounts.get('customXml/item1.xml') || 0, 0,
      'getInfo should not decompress unrelated custom XML parts');

    console.log('OK DOCX read and getInfo avoid unused XML decompression');
  } finally {
    zipObjectPrototype.asText = originalAsText;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

runIfMain(import.meta.url, runTests);