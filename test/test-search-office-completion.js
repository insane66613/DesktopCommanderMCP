/** A ripgrep close is not the end of an in-flight Excel/DOCX search. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createTestEnv, isTestHome, createTempDir } from './helpers/test-env.js';

async function run() {
  const { searchManager } = await import('../dist/search-manager.js');
  const { configManager } = await import('../dist/config-manager.js');
  const previousConfig = await configManager.getConfig();
  const dir = createTempDir('dc-office-outcome-');
  fs.writeFileSync(path.join(dir, 'ordinary.txt'), 'nothing relevant\n');
  await configManager.setValue('allowedDirectories', [dir]);
  const excel = searchManager.searchExcelFiles;
  const docx = searchManager.searchDocxFiles;
  const waitFor = async (fn, message) => {
    const deadline = Date.now() + 8000;
    while (!fn()) {
      assert(Date.now() < deadline, message);
      await new Promise(resolve => setTimeout(resolve, 15));
    }
  };
  function deferred() {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  }
  async function startOffice(kind, pending, timeout) {
    const method = kind === 'xlsx' ? 'searchExcelFiles' : 'searchDocxFiles';
    searchManager[method] = () => pending.promise;
    const started = await searchManager.startSearch({
      rootPath: dir, pattern: 'needle', searchType: 'content',
      filePattern: '*.' + kind, timeout,
    });
    const session = searchManager.sessions.get(started.sessionId);
    assert.equal(session.pendingOffice, 1, kind + ' must be tracked as an active source');
    await waitFor(() => session.ripgrepClosed, 'ripgrep did not finish');
    assert.equal(session.isComplete, false, kind + ' must not complete before Office');
    return session;
  }
  const hit = { type: 'content', file: 'X:/fixture/office.xlsx', line: 1, match: 'needle' };
  try {
    for (const kind of ['xlsx', 'docx']) {
      const task = deferred();
      const session = await startOffice(kind, task);
      task.resolve([hit]);
      await waitFor(() => session.isComplete, kind + ' did not finish after resolve');
      assert.equal(session.outcome, 'completed');
      assert.equal(searchManager.readSearchResults(session.id).totalMatches, 1);
    }
    const bad = deferred();
    const errored = await startOffice('xlsx', bad);
    bad.reject(new Error('Office read failed'));
    await waitFor(() => errored.isComplete, 'Office rejection did not complete');
    assert.equal(errored.outcome, 'partial', 'Office rejection must not claim exhaustive search');

    const late = deferred();
    const timedOut = await startOffice('xlsx', late, 100);
    await waitFor(() => timedOut.isComplete, 'Office timeout did not finalize');
    assert.equal(timedOut.outcome, 'timed_out');
    late.resolve([hit]);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(searchManager.readSearchResults(timedOut.id).totalMatches, 0,
      'late Office results must not mutate completed pagination');

    const stoppedTask = deferred();
    const stopped = await startOffice('docx', stoppedTask);
    assert.equal(searchManager.terminateSearch(stopped.id), true);
    assert.equal(stopped.outcome, 'stopped');
    stoppedTask.resolve([hit]);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(searchManager.readSearchResults(stopped.id).totalMatches, 0);
    const stillRunning = {
      id: 'office-still-running', process: {
        killed: false, kill() { this.killed = true; return true; },
      }, isComplete: false, isError: false, pendingOffice: 1,
      ripgrepClosed: false, startTime: Date.now() - 10, lastReadTime: Date.now(),
      options: { rootPath: dir, pattern: 'needle', searchType: 'content' },
      results: [], skippedLines: new Map(), totalMatches: 0, totalContextLines: 0,
    };
    searchManager.sessions.set(stillRunning.id, stillRunning);
    assert.equal(searchManager.terminateSearch(stillRunning.id), true);
    assert.equal(stillRunning.isComplete, true);
    assert.equal(stillRunning.outcome, 'stopped');

    console.log('PASS: Excel/DOCX completion, failure, timeout, stop, and late-result safety');
  } finally {
    searchManager.searchExcelFiles = excel;
    searchManager.searchDocxFiles = docx;
    searchManager.dispose();
    await configManager.updateConfig(previousConfig);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
if (!isTestHome()) {
  const isolated = createTestEnv();
  try {
    const p = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      env: isolated.env, stdio: 'inherit', timeout: 30000,
    });
    assert.equal(p.status, 0, p.error?.message || 'Office completion test failed');
  } finally {
    isolated.cleanup();
  }
} else {
  await run();
}
