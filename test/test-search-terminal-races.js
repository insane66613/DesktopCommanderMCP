/** Error and close events must not restart a completed search's stopwatch. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createTestEnv, isTestHome } from './helpers/test-env.js';

async function run() {
  const { searchManager } = await import('../dist/search-manager.js');
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  function fakeSession(name, matches) {
    const process = new EventEmitter();
    process.stdout = new EventEmitter();
    process.stderr = new EventEmitter();
    process.stdout.setEncoding = () => {};
    process.stderr.setEncoding = () => {};
    process.killed = false;
    process.kill = () => { process.killed = true; return true; };
    const session = {
      id: name, process, isComplete: false, isError: false,
      results: Array.from({ length: matches }, (_, i) => ({
        type: 'file', file: 'X:/fixture/hit-' + i,
      })),
      startTime: Date.now() - 1000, lastReadTime: Date.now(),
      options: { rootPath: 'X:/fixture', pattern: 'hit', searchType: 'files' },
      buffer: '', skippedLines: new Map(), totalMatches: matches, totalContextLines: 0,
    };
    searchManager.sessions.set(name, session);
    searchManager.setupProcessHandlers(session);
    return session;
  }
  try {
    for (const matches of [0, 1]) {
      const id = 'error-then-close-' + matches;
      const session = fakeSession(id, matches);
      session.process.emit('error', new Error('simulated process failure'));
      const first = searchManager.readSearchResults(id);
      assert.equal(first.isComplete, true);
      assert.equal(first.isError, true, 'an actual process error is never success');
      const frozenAt = session.endTime;
      await delay(50);
      session.process.emit('close', null);
      assert.equal(session.endTime, frozenAt, 'close must not move first terminal timestamp');
      assert.equal(searchManager.readSearchResults(id).runtime, first.runtime);
      assert.equal(searchManager.readSearchResults(id).isError, true);
      assert.equal(searchManager.listSearchSessions().find(s => s.id === id).runtime, first.runtime);
    }
    const session = fakeSession('close-then-error', 0);
    session.process.emit('close', 0);
    const first = searchManager.readSearchResults(session.id);
    await delay(50);
    session.process.emit('error', new Error('late failure'));
    assert.equal(searchManager.readSearchResults(session.id).runtime, first.runtime);
    assert.equal(searchManager.readSearchResults(session.id).isError, true);
    console.log('PASS: search runtime and hard errors survive terminal event races');
  } finally {
    searchManager.dispose();
  }
}
if (!isTestHome()) {
  const isolated = createTestEnv();
  try {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      env: isolated.env, stdio: 'inherit', timeout: 15000,
    });
    assert.equal(child.status, 0, child.error?.message || 'search race test failed');
  } finally {
    isolated.cleanup();
  }
} else {
  await run();
}
