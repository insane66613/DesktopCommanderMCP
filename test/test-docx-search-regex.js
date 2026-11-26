import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import PizZip from 'pizzip';
import { searchManager } from '../dist/search-manager.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-docx-regex-'));
const filename = path.join(dir, 'report.[2026]+.docx');
const part = (...contents) =>
  '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
  contents.map(text => '<w:p><w:r><w:t>' + text + '</w:t></w:r></w:p>').join('') +
  '</w:document>';
try {
  const zip = new PizZip();
  zip.file('word/document.xml', part('Order ID: A-123', 'literal a.b', 'literal aXb'));
  zip.file('word/header4.xml', part('CASE MODE'));
  zip.file('word/footer5.xml', part('Order ID: B-456'));
  fs.writeFileSync(filename, zip.generate({ type: 'nodebuffer' }));
  const search = (pattern, ignoreCase = true, max = 20, literal = false) =>
    searchManager.searchDocxFiles(dir, pattern, ignoreCase, max, '*.docx', literal);

  const regex = await search('Order ID: [AB]-\\d{3}');
  assert.deepEqual(regex.map(r => r.file), [filename, filename + ':footer5.xml']);
  assert.equal(regex[0].line, 1);
  assert.equal(regex[1].line, 1);
  assert.ok(regex[0].match.includes('A-123'));
  const limited = await search('Order ID: [AB]-\\d{3}', true, 1);
  assert.deepEqual(limited.map(r => r.file), [filename], 'maxResults is global');
  const explicit = await search('a.b', true, 20, true);
  assert.deepEqual(explicit.map(r => r.line), [2], 'literal mode must not match aXb');
  const wildcard = await search('a.b', true, 20, false);
  assert.deepEqual(wildcard.map(r => r.line), [2, 3], 'regex dot matches both');
  assert.equal((await search('case mode', false)).length, 0, 'case-sensitive');
  assert.equal((await search('case mode', true)).length, 1, 'ignoreCase');
  const session = await searchManager.startSearch({
    rootPath: dir, searchType: 'content', pattern: 'Order ID: [AB]-\\d{3}',
    ignoreCase: true, filePattern: '*.docx', literalSearch: false,
    maxResults: 10, timeout: 15000,
  });
  let result = searchManager.readSearchResults(session.sessionId);
  const deadline = Date.now() + 12000;
  while (!result.isComplete && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
    result = searchManager.readSearchResults(session.sessionId);
  }
  assert.equal(result.isComplete, true, 'Office search completion must wait for regex results');
  assert.equal(result.outcome, 'completed', JSON.stringify(result));
  assert.deepEqual(result.results.filter(hit => hit.file.endsWith('.docx') || hit.file.endsWith(':footer5.xml'))
    .map(hit => hit.file), [filename, filename + ':footer5.xml'],
    'real start_search must expose body and footer regex results');
  await assert.rejects(search('('), /regex|pattern|parse|error/i, 'invalid regex must be reported');
  const invalid = await searchManager.startSearch({
    rootPath: dir, searchType: 'content', pattern: '(',
    filePattern: '*.docx', literalSearch: false, timeout: 15000,
  });
  let bad = searchManager.readSearchResults(invalid.sessionId);
  const invalidDeadline = Date.now() + 12000;
  while (!bad.isComplete && Date.now() < invalidDeadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
    bad = searchManager.readSearchResults(invalid.sessionId);
  }
  assert.equal(bad.isComplete, true, 'invalid regex must produce a terminal session');
  assert.equal(bad.isError, true, 'invalid pattern must be failed rather than silently partial');
  assert.match(bad.error ?? '', /regex|parse|error/i, 'the public result must explain the failure');
  const pathological = 'a'.repeat(4096) + '!';
  const stressZip = new PizZip();
  stressZip.file('word/document.xml', part(pathological));
  const stress = path.join(dir, 'redos.docx');
  fs.writeFileSync(stress, stressZip.generate({ type: 'nodebuffer' }));
  const start = Date.now();
  await search('(a+)+$', true, 20, false);
  assert.ok(Date.now() - start < 5000, 'regex engine must avoid catastrophic backtracking');
  console.log('PASS: DOCX regex/literal/case/global cap/invalid pattern/linear-time search');
} finally {
  searchManager.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
}
