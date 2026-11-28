import assert from 'node:assert/strict';
import { SearchManager } from '../dist/search-manager.js';

// The regex engine can stop at --max-count while Node is still writing stdin.
// EPIPE from that deliberate close must not discard a valid capped result.
const search = new SearchManager();
try {
  const cells = [{text:'needle at start',file:'first.docx',line:1}];
  for (let i = 1; i < 27000; i++) {
    cells.push({text:'not-a-match-'.repeat(10),file:'first.docx',line:i+1});
  }
  const matches = await search.matchDocxRegexCells(cells,'needle',true,1);
  assert.equal(matches.length,1,'valid early result must be preserved');
  assert.equal(matches[0].file,'first.docx');
  assert.match(matches[0].match,/needle/);
  console.log('PASS: DOCX regex ignores expected early stdin closure after reaching result cap');
} finally {
  search.dispose();
}
