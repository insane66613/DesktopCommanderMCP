import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { createTestEnv } from './helpers/test-env.js';

if (process.argv[2] === 'launcher') {
  spawn(process.execPath, ['-e', `setTimeout(() => {
    console.log('late-stdout'); console.error('late-stderr');
  }, 1500);`], { detached: true, stdio: ['ignore', 1, 2] }).unref();
  console.log('launcher-output');
} else {
  const env = createTestEnv();
  Object.assign(process.env, env.env);
  const { TerminalManager } = await import(process.env.DC_TERMINAL_MODULE || '../dist/terminal-manager.js');
  const manager = new TerminalManager();
  const shell = process.platform === 'win32' ? 'pwsh.exe' : '/bin/sh';
  const quote = value => process.platform === 'win32'
    ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", "'\\''")}'`;
  try {
    const pending = manager.executeCommand(`${process.platform === 'win32' ? '& ' : ''}${quote(process.execPath)} ${quote(import.meta.filename)} launcher`, 10000, shell);
    while (!manager.listActiveSessions().length) await new Promise(resolve => setTimeout(resolve, 10));
    const { pid } = manager.listActiveSessions()[0];
    const child = manager.getSession(pid).process;
    let closed = false;
    const close = new Promise(resolve => child.once('close', () => { closed = true; resolve(); }));
    const result = await pending;
    try {
      assert.equal(closed, false, 'exited launcher must return before its descendant closes inherited stdio');
      assert.equal(result.isBlocked, false);
      assert.deepEqual(manager.getProcessStatus(pid), { isComplete: true, exitCode: 0, outputClosed: false });
      assert.deepEqual(manager.listActiveSessions(), []);
      assert.equal(await manager.sendInputToProcess(pid, 'input'), false);
      assert.equal(manager.forceTerminate(pid), false);
      assert.match(manager.readOutputPaginated(pid).lines.join('\n'), /launcher-output/);
    } finally { await close; }
    const late = manager.readOutputPaginated(pid);
    assert.match(late.lines.join('\n'), /late-stdout\nlate-stderr/);
    assert.equal(late.isComplete, true);
    assert.equal(manager.readOutputPaginated(pid).lines.join('\n'), '', 'late close must not reset the read cursor');

    // A delayed close from an exited PID must not replace a newer generation.
    const originalSpawn = childProcess.spawn;
    const fakePid = 987653;
    try {
      const child = Object.assign(new EventEmitter(), {
        pid: fakePid, stdout: new EventEmitter(), stderr: new EventEmitter(),
      });
      childProcess.spawn = () => child;
      syncBuiltinESMExports();
      const execution = manager.executeCommand('echo fake', 10000, shell);
      while (!manager.getSession(fakePid)) await new Promise(resolve => setTimeout(resolve, 1));
      const activeBeforeExit = manager.getSession(fakePid);
      child.stdout.emit('data', Buffer.from('partial'));
      child.emit('exit', 7);
      await execution;
      assert.equal(activeBeforeExit.outputLines.length, 0, 'completed output must release duplicate active buffer');
      assert.equal(manager.readOutputPaginated(fakePid).lines.join('\n'), 'partial');
      child.stdout.emit('data', Buffer.from('-late\n'));
      assert.equal(manager.readOutputPaginated(fakePid).lines.join('\n'), '-late');
      const old = manager.listCompletedSessions().find(session => session.pid === fakePid);
      manager.completedSessions.delete(fakePid); // Simulate eviction before inherited pipes close.
      child.stdout.emit('data', Buffer.from('after-eviction\n'));
      const replacement = { ...old, generation: old.generation + 1 };
      manager.sessions.set(fakePid, replacement);
      child.emit('close', 7);
      assert.equal(manager.getSession(fakePid), replacement);
      assert.equal(manager.completedSessions.has(fakePid), false, 'late close must not resurrect an evicted session');
      manager.sessions.delete(fakePid);
      const failed = Object.assign(new EventEmitter(), {
        pid: fakePid, stdout: new EventEmitter(), stderr: new EventEmitter(),
      });
      childProcess.spawn = () => failed;
      syncBuiltinESMExports();
      const failure = manager.executeCommand('echo failed', 10000, shell);
      while (!manager.getSession(fakePid)) await new Promise(resolve => setTimeout(resolve, 1));
      failed.stderr.emit('data', Buffer.from('retained-error-output'));
      failed.stderr.emit('error', Object.assign(new Error('synthetic stream failure'), { code: 'EIO' }));
      failed.emit('error', new Error('synthetic process failure'));
      assert.match((await failure).output, /synthetic process failure/);
      failed.emit('close', -1);
      assert.deepEqual(manager.getProcessStatus(fakePid), { isComplete: true, exitCode: -1, outputClosed: true });
      assert.match(manager.readOutputPaginated(fakePid).lines.join('\n'), /retained-error-output/);
      assert.match(manager.readOutputPaginated(fakePid).outputError, /stderr stream failed.*EIO/);
    } finally {
      childProcess.spawn = originalSpawn;
      syncBuiltinESMExports();
      manager.sessions.delete(fakePid);
    }
    // Pending inherited pipes must not defeat the global completed-session cap.
    const retention = new TerminalManager();
    let firstPending;
    for (let i = 0; i < 101; i++) {
      const entry = {
        pid: 950000 + i, outputClosed: false, outputLines: ['late-output'],
        bufferedChars: 11, generation: i + 1, outputVersion: 0, lifecycleVersion: 0,
      };
      if (i === 0) firstPending = entry;
      retention.completedSessions.set(entry.pid, entry);
    }
    retention.pruneCompletedSessions();
    assert.equal(retention.completedSessions.size, 100, 'pending drains must not bypass global cap');
    assert.equal(firstPending.outputLines.length, 0, 'evicted output must release retained buffers');
    assert.match(retention.getEvictedCompletionNotice(firstPending.pid), /evicted.*output/i);

    // Stalled stdin callbacks must not pin an interactive MCP tool indefinitely.
    const fakeStdin = Object.assign(new EventEmitter(), {
      writable: true, writableEnded: false, destroyed: false,
      write: (_value, _callback) => true,
    });
    const pendingPid = 960000;
    retention.sessions.set(pendingPid, { process: { stdin: fakeStdin } });
    await assert.rejects(retention.sendInputToProcess(pendingPid, 'hello', 30), /indeterminate.*Do not retry/i);
    assert.equal(fakeStdin.listenerCount('error'), 0);
    assert.equal(fakeStdin.listenerCount('close'), 0);
    retention.sessions.delete(pendingPid);

    console.log('Inherited stdio: exited PID completes promptly, late output and cursor survive close, PID reuse is safe.');
  } finally { env.cleanup(); }
}
