import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import PizZip from 'pizzip';
import { SearchManager } from '../dist/search-manager.js';

const manager = new SearchManager();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-docx-global-cap-'));
const xml = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
  Array.from({length: 3000}, () => '<w:p><w:r><w:t>needle</w:t></w:r></w:p>').join('') +
  '</w:document>';
try {
  for (const name of ['first.docx', 'second.docx']) {
    const zip = new PizZip();
    zip.file('word/document.xml', xml);
    fs.writeFileSync(path.join(root, name), zip.generate({type:'nodebuffer'}));
  }
  let truncated = 0;
  const matches = await manager.searchDocxFiles(root, 'needle', true, undefined,
    '*.docx', false, undefined, () => { truncated++; });
  assert.equal(matches.length, 5000, '5000 cap must cover all DOCX documents combined');
  assert.ok(truncated > 0, 'global cap with no caller limit must report incomplete search');
  let excessiveRequestTruncated = 0;
  const explicitlyRequested = await manager.searchDocxFiles(root, 'needle', true, 6000,
    '*.docx', false, undefined, () => { excessiveRequestTruncated++; });
  assert.equal(explicitlyRequested.length, 5000,
    'safety cap still applies when caller requests more than 5000');
  assert.ok(excessiveRequestTruncated > 0,
    'request above safety cap must not silently report complete');
  const context = {
    id:'test-limit', process:{}, options:{searchType:'content', maxResults:2},
    results:[{file:'office.docx', type:'content', match:'needle'}],
    totalMatches:1, totalContextLines:0, skippedLines:new Map(),
    startTime:Date.now(), isComplete:false, isError:false, ripgrepClosed:false
  };
  const match = (n) => JSON.stringify({type:'match', data:{
    path:{text:'file.txt'}, line_number:n, lines:{text:'needle'},
    submatches:[{match:{text:'needle'},start:0,end:6}]
  }});
  manager.processLines(context, [match(1), match(2)]);
  assert.equal(context.totalMatches,2,'primary search cannot exceed global Office-first cap');
  assert.equal(context.results.length,2,'skipped matches must not enter session results');

  const abort = new AbortController();
  const forced = {...context, id:'test-force', totalMatches:0, results:[],
    ripgrepClosed:true, processError:true, officeAbort:abort, pendingOffice:1,
    isComplete:false, isError:false, error:'Process error: spawn failed'};
  manager.finishSearchIfReady(forced, true);
  assert.equal(abort.signal.aborted,true,'forced failure must cancel Office work');
  assert.equal(forced.outcome,'failed');
  console.log('PASS: DOCX aggregate cap, mixed-source match cap, and force-abort ownership');
} finally {
  manager.dispose();
  fs.rmSync(root,{recursive:true,force:true});
}
