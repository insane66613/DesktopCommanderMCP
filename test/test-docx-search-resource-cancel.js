import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import PizZip from 'pizzip';
import { SearchManager } from '../dist/search-manager.js';

const search = new SearchManager();
const one = (text) => [{text,file:'f.docx',line:1}];
const root = fs.mkdtempSync(path.join(os.tmpdir(),'dc-docx-stop-'));
try {
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(search.matchDocxRegexCells(one('test'), 'test', true, 10, aborted.signal),
    /aborted/i);
  await assert.rejects(search.matchDocxRegexCells(one('x'.repeat(9 * 1024 * 1024)), 'x', true),
    /input.*byte budget/i);
  await assert.rejects(search.matchDocxRegexCells(one('x'.repeat(3 * 1024 * 1024)), 'x', true),
    /cumulative output.*budget/i);
  const unicode = await search.matchDocxRegexCells(one('a'.repeat(70000) + ' é🧪 café match'),
    'café', true, 2);
  assert.equal(unicode.length, 1);
  assert.ok(unicode[0].match.includes('café match'), JSON.stringify(unicode));
  const zip = new PizZip();
  zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Order A-123</w:t></w:r></w:p></w:document>');
  const doc = zip.generate({type:'nodebuffer'});
  for(let i=0;i<120;i++) fs.writeFileSync(path.join(root,'doc'+i+'.docx'),doc);
  // Make the search's Office discovery deterministically remain in flight
  // after the ordinary rg process exits; stopping must abort that work.
  const originalFind = search.findDocxFiles.bind(search);
  search.findDocxFiles = async (...args) => {
    await new Promise(resolve => setTimeout(resolve, 400));
    return originalFind(...args);
  };
  const started = await search.startSearch({
    rootPath:root,searchType:'content',pattern:'Order [A-Z]-\\d{3}',
    ignoreCase:true,filePattern:'*.docx',literalSearch:false,
    timeout:15000,maxResults:20,
  });
  const internal = search.sessions.get(started.sessionId);
  assert.equal(internal.pendingOffice, 1, 'Office scan must be in progress');
  const stopped=search.terminateSearch(started.sessionId);
  assert.equal(internal.officeAbort.signal.aborted, true,
    'stop must signal cancellation to owned DOCX tasks');
  assert.equal(stopped,true,'the active search should accept stop');
  await new Promise(resolve=>setTimeout(resolve,250));
  const result=search.readSearchResults(started.sessionId);
  assert.equal(result.isComplete,true);
  assert.equal(result.outcome,'stopped',JSON.stringify(result));
  assert.ok(result.totalMatches<=20,'stale DOCX matches must not leak after cancellation');
  console.log('PASS: DOCX regex input/output budgets, UTF-8, and session-owned cancellation');
} finally {
  search.dispose();
  fs.rmSync(root,{recursive:true,force:true});
}
