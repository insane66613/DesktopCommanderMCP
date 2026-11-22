/** Real ripgrep completion outcomes, beyond injected event simulations. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createTestEnv, isTestHome, createTempDir } from './helpers/test-env.js';

async function run() {
  const { searchManager } = await import('../dist/search-manager.js');
  const { configManager } = await import('../dist/config-manager.js');
  const { handleStartSearch, handleGetMoreSearchResults } = await import('../dist/handlers/search-handlers.js');
  const { enrichStructuredContent } = await import('../dist/structured-content.js');
  const dir = createTempDir('dc-search-outcome-real-');
  const originalConfig = await configManager.getConfig();
  try {
    fs.writeFileSync(path.join(dir, 'matches.txt'), 'found\nfound\nfound\n');
    await configManager.setValue('allowedDirectories', [dir]);
    for (const [pattern, maxResults, expected] of [
      ['found', undefined, 'completed'],
      ['found', 1, 'max_results'],
      ['(unclosed', undefined, 'failed'],
    ]) {
      const started = await handleStartSearch({
        path: dir, pattern, searchType: 'content', maxResults,
      });
      const id = /session:\s*(\S+)/i.exec(started.content[0].text)?.[1];
      assert(id, 'A real search must return a session ID');
      const until = Date.now() + 10000;
      while (!searchManager.readSearchResults(id).isComplete) {
        assert(Date.now() < until, 'Timed out waiting for ripgrep');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      const state = searchManager.readSearchResults(id);
      assert.equal(state.outcome, expected, 'real ripgrep disposition for ' + pattern);
      const answer = await handleGetMoreSearchResults({ sessionId: id, offset: 0, length: 20 });
      const machine = enrichStructuredContent('get_more_search_results', answer).structuredContent;
      assert.equal(machine?.outcome, expected);
      assert.equal(machine?.status, expected.toUpperCase());
      assert.equal(machine?.success, expected !== 'failed');
    }
    console.log('PASS: real ripgrep clean, result-limited and regex-failed outcomes');
  } finally {
    searchManager.dispose();
    await configManager.updateConfig(originalConfig);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
if (!isTestHome()) {
  const isolated = createTestEnv();
  try {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      env: isolated.env, stdio: 'inherit', timeout: 30000,
    });
    assert.equal(child.status, 0, child.error?.message || 'real search outcome test failed');
  } finally {
    isolated.cleanup();
  }
} else {
  await run();
}
