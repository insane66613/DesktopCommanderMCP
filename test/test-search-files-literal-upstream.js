import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { searchManager } from '../dist/search-manager.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const root = await fs.mkdtemp(path.join(testDir, '__literal_filename_'));
const paths = ['report[1].txt', 'report1.txt', 'sub/report[1].txt',
  'notes{a}.md', 'notesa.md', 'notesb.md'];
try {
  for (const name of paths) {
    const full = path.join(root, name);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, 'literal fixture');
  }

  const cases = [
    ['report[1].txt', true, ['report[1].txt', 'sub/report[1].txt']],
    ['rt[1]', true, ['report[1].txt', 'sub/report[1].txt']],
    ['{a}', true, ['notes{a}.md']],
    ['report[1].txt', false, ['report1.txt']],
    ['notes{a,b}.md', false, ['notesa.md', 'notesb.md']],
  ];
  for (const [pattern, literalSearch, expected] of cases) {
    const started = await searchManager.startSearch({
      rootPath: root, pattern, searchType: 'files', literalSearch,
      ignoreCase: true, maxResults: 100, earlyTermination: false, timeout: 10000,
    });
    let results;
    for (let i = 0; i < 400; i++) {
      results = searchManager.readSearchResults(started.sessionId, 0, 100);
      if (results.isComplete) break;
      await delay(20);
    }
    assert.ok(results?.isComplete, `Search did not complete: ${pattern}`);
    assert.equal(results.isError, false, `Unexpected ripgrep error: ${pattern}: ${results.error}`);
    const actual = results.results.map(r => path.relative(root, r.file).replaceAll('\\', '/')).sort();
    assert.deepEqual(actual, [...expected].sort(),
      `literalSearch=${literalSearch} pattern=${pattern} returned ${actual}`);
    console.log(`PASS literal=${literalSearch} pattern=${pattern} matches=${actual.length}`);
  }
} finally {
  searchManager.dispose();
  await fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 });
}
