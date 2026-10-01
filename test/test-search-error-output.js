/**
 * What a search keeps of ripgrep's error output (stderr): each piece once, and
 * no more than a bounded amount. It is the error an answer shows when a search
 * fails without results, and a session keeps it until it is cleaned up.
 * Before, every chunk was kept whole and its "meaningful" lines (those not
 * starting with "rg:") a second time, without limit.
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { searchManager } from '../dist/search-manager.js';
import { configManager } from '../dist/config-manager.js';
import { handleStartSearch } from '../dist/handlers/search-handlers.js';
import { runIfMain } from './helpers/run-if-main.js';
import { createTempDir } from './helpers/test-env.js';

const MAX_KEPT_CHARS = 64 * 1024;

export default async function runTests() {
  const originalConfig = await configManager.getConfig();
  const dir = createTempDir('dc-search-errors-');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'text\n');
  await configManager.setValue('allowedDirectories', [dir]);
  let sessionId;
  try {
    // An unclosed group: ripgrep writes its regex error to stderr and exits. The
    // search could not run, which its answer may say as an error: wait for the
    // session to end, whatever it answers
    const started = await handleStartSearch({ path: dir, pattern: '(unclosed', searchType: 'content' });
    sessionId = /session: (\S+)/.exec(started.content?.[0]?.text ?? '')?.[1];
    assert(sessionId, `start_search did not return a session id: ${started.content?.[0]?.text}`);
    const deadline = Date.now() + 10_000;
    while (!searchManager.readSearchResults(sessionId).isComplete) {
      assert(Date.now() < deadline, 'search did not complete within 10 seconds');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const { error } = searchManager.readSearchResults(sessionId);
    const occurrences = (error ?? '').split('unclosed group').length - 1;
    assert.strictEqual(occurrences, 1, `ripgrep's error should be kept once, got ${occurrences} times:\n${error}`);
    console.log('✓ ripgrep\'s error output is kept once');

    // More error output than a session keeps, through the session's own stderr handler
    const session = searchManager['sessions'].get(sessionId);
    session.process.stderr.emit('data', Buffer.from('x'.repeat(4 * MAX_KEPT_CHARS)));
    const kept = searchManager.readSearchResults(sessionId).error ?? '';
    assert(kept.length <= MAX_KEPT_CHARS, `a session should keep at most ${MAX_KEPT_CHARS} characters of error output, kept ${kept.length}`);
    assert(kept.includes('unclosed group'), 'what was kept first should stay');
    console.log(`✓ at most ${MAX_KEPT_CHARS} characters of error output are kept`);
  } finally {
    searchManager.dispose();
    await configManager.updateConfig(originalConfig);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return true;
}

runIfMain(import.meta.url, runTests);
