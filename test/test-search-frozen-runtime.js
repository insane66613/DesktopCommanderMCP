/** Live ripgrep regression: terminal search runtime is fixed after completion. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createTestEnv, isTestHome, createTempDir } from './helpers/test-env.js';

async function run() {
  const { searchManager } = await import('../dist/search-manager.js');
  const { configManager } = await import('../dist/config-manager.js');
  const oldConfig = await configManager.getConfig();
  const dir = createTempDir('dc-search-runtime-');
  let id;
  try {
    fs.writeFileSync(path.join(dir, 'marker.txt'), 'freeze-marker\n');
    await configManager.setValue('allowedDirectories', [dir]);
    const started = await searchManager.startSearch({
      rootPath: dir, pattern: 'freeze-marker', searchType: 'content',
    });
    id = started.sessionId;
    const deadline = Date.now() + 10000;
    while (!searchManager.readSearchResults(id).isComplete) {
      assert(Date.now() < deadline, 'ripgrep did not exit within 10s');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const first = searchManager.readSearchResults(id);
    assert.equal(first.isComplete, true);
    assert(first.totalMatches >= 1, 'test fixture must return a match');
    const session = searchManager.sessions.get(id);
    assert(Number.isFinite(session.endTime), 'terminal event should set endTime');
    assert(session.endTime >= session.startTime, 'completion cannot precede start');
    await new Promise(resolve => setTimeout(resolve, 75));
    const tail = searchManager.readSearchResults(id, -1, 1);
    const listed = searchManager.listSearchSessions().find(s => s.id === id);
    assert.equal(tail.runtime, first.runtime, 'tail pagination cannot increase elapsed time');
    assert.equal(listed.runtime, first.runtime, 'listing cannot increase elapsed time');
    assert.equal(session.lastReadTime > session.endTime, true, 'tail read refreshes retention');
    searchManager.cleanupSessions(1000);
    assert(searchManager.sessions.has(id), 'a recent tail read keeps the session');
    console.log('PASS: completed runtime stable; tail reads refresh retention');
  } finally {
    searchManager.dispose();
    await configManager.updateConfig(oldConfig);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
if (!isTestHome()) {
  const isolated = createTestEnv();
  try {
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      env: isolated.env, stdio: 'inherit', timeout: 30000,
    });
    assert.equal(result.status, 0, result.error?.message || 'search runtime test failed');
  } finally {
    isolated.cleanup();
  }
} else {
  await run();
}
