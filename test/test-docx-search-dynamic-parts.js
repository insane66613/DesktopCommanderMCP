import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import PizZip from 'pizzip';
import { searchManager } from '../dist/search-manager.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-docx-parts-'));
const filename = path.join(dir, 'header[4]+footer(5).docx');
const xml = (text) => '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
  '<w:p><w:r><w:t>' + text + '</w:t></w:r></w:p></w:document>';
try {
  const zip = new PizZip();
  zip.file('word/document.xml', xml('needle main body'));
  // Intentionally scramble archive insertion order to exercise deterministic
  // body -> header2 -> header4 -> header10 -> footer3 -> footer5 ordering.
  zip.file('word/footer5.xml', xml('needle footer five'));
  zip.file('word/header10.xml', xml('needle header ten'));
  zip.file('word/header4.xml', xml('needle header four'));
  zip.file('word/footer3.xml', xml('needle footer three'));
  zip.file('word/header2.xml', xml('needle header two'));
  zip.file('word/footnotes.xml', xml('needle intentionally excluded'));
  fs.writeFileSync(filename, zip.generate({ type: 'nodebuffer' }));
  const hits = await searchManager.searchDocxFiles(dir, 'needle', true, 20, '*.docx', true);
  assert.equal(hits.length, 6, 'document plus all numbered headers/footers should be searchable');
  assert.deepEqual(hits.map(hit => hit.file), [filename, ...[
    'header2.xml', 'header4.xml', 'header10.xml', 'footer3.xml', 'footer5.xml'
  ].map(part => filename + ':' + part)], 'stable body/header/footer numeric ordering');
  assert.ok(hits.some(hit => hit.file === filename && hit.match.includes('main body')));
  assert.ok(hits.some(hit => hit.file === filename + ':header4.xml'));
  assert.ok(hits.some(hit => hit.file === filename + ':footer5.xml'));
  assert.equal(hits.some(hit => hit.file.includes('footnotes.xml')), false);
  const bounded = await searchManager.searchDocxFiles(dir, 'needle', true, 2, '*.docx', true);
  assert.equal(bounded.length, 2, 'maxResults applies to all XML parts combined');
  assert.deepEqual(bounded.map(hit => hit.file), [filename, filename + ':header2.xml'],
    'body and earliest header take precedence when results are capped');
  console.log('PASS: DOCX body, dynamic numbered parts, deterministic precedence and global cap');
} finally {
  searchManager.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
}
