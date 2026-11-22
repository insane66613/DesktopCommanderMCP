/** Concurrent force_terminate shares one tree kill; a failed kill can be retried. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { terminalManager } from '../dist/terminal-manager.js';
import { runIfMain } from './helpers/run-if-main.js';

const here = fileURLToPath(import.meta.url);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function runTests() {
  const child = spawn(process.execPath, [here, '--hold-child'], {
    stdio: 'ignore', windowsHide: true,
  });
  assert(child.pid > 0, 'must create an isolated child for termination');
  const session = {
    pid: child.pid, process: child, lifecycleVersion: 0,
    generation: 1, outputVersion: 0, outputLines: [], bufferedChars: 0,
    evictedChars: 0, evictedLines: 0, lastReadIndex: 0,
  };
  terminalManager.sessions.set(child.pid, session);
  try {
    const calls = [
      terminalManager.forceTerminateAndWait(child.pid),
      terminalManager.forceTerminateAndWait(child.pid),
      terminalManager.forceTerminateAndWait(child.pid),
    ];
    const results = await Promise.all(calls);
    assert.deepEqual(results, ['ended','ended','ended'],
      'three concurrent requests must share one real tree termination');
    assert.equal(session.lifecycleVersion, 1,
      'one in-flight termination should advance lifecycle once');
    assert.equal(terminalManager.terminationInFlight.get(session), undefined,
      'completed promise should not remain cached');
    // Reproduce upstream def14b90: a failed kill may not poison the next one.
    const retryChild = spawn(process.execPath, [here, '--hold-child'], {
      stdio: 'ignore', windowsHide: true,
    });
    assert(retryChild.pid > 0);
    const retrySession = {
      ...session, pid: retryChild.pid, process: retryChild, lifecycleVersion: 0,
    };
    terminalManager.sessions.set(retryChild.pid, retrySession);
    const originalKill = retryChild.kill;
    const previousSystemRoot = process.env.SystemRoot;
    const previousPath = process.env.PATH;
    try {
      retryChild.kill = () => true; // Simulate an ineffective fallback signal.
      if (process.platform === 'win32') {
        process.env.SystemRoot = path.join(path.dirname(here), 'nonexistent-system-root');
      } else {
        process.env.PATH = path.join(path.dirname(here), 'nonexistent-bin');
      }
      const failed = await terminalManager.forceTerminateAndWait(retryChild.pid);
      assert.equal(failed, 'failed', 'first unavailable tree kill must fail');
      assert.equal(terminalManager.terminationInFlight.get(retrySession), undefined);
      retryChild.kill = originalKill;
      if (previousSystemRoot === undefined) delete process.env.SystemRoot;
      else process.env.SystemRoot = previousSystemRoot;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      const next = await terminalManager.forceTerminateAndWait(retryChild.pid);
      assert.equal(next, 'ended', 'second request must retry a previously failed kill');
      assert.equal(retrySession.lifecycleVersion, 2);
    } finally {
      retryChild.kill = originalKill;
      if (previousSystemRoot === undefined) delete process.env.SystemRoot;
      else process.env.SystemRoot = previousSystemRoot;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      terminalManager.sessions.delete(retryChild.pid);
      if (retryChild.exitCode === null && retryChild.signalCode === null) {
        retryChild.kill('SIGKILL');
        await sleep(100);
      }
    }
    console.log('PASS: concurrent termination coalesces, failed termination retries');
    return true;
  } finally {
    terminalManager.sessions.delete(child.pid);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await sleep(100);
    }
  }
}
if (process.argv[2] === '--hold-child') {
  setInterval(() => {}, 2000);
} else {
  runIfMain(import.meta.url, runTests);
}
