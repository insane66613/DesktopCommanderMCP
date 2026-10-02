import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { createTestEnv } from './helpers/test-env.js';

const env = createTestEnv();
Object.assign(process.env, env.env);
const { terminalManager } = await import('../dist/terminal-manager.js');
const { startProcess } = await import('../dist/tools/improved-process-tools.js');
const { enrichStructuredContent } = await import('../dist/structured-content.js');
const { outputSchemaForTool } = await import('../dist/output-schemas.js');
const originalExecute = terminalManager.executeCommand;
const shell = process.platform === 'win32' ? 'pwsh.exe' : '/bin/sh';
const fakePid = 987655;

try {
  // Output may resemble a prompt after exit, or an error while still running.
  for (const [state, output, exitCode] of [
    ['finished', '>>> ', 7],
    ['finished', '', null],
    ['running', 'Error: still working', null],
    ['waiting_for_input', '>>> ', null],
    ['unknown', '', null],
  ]) {
    const completed = state === 'finished';
    terminalManager.executeCommand = async () => {
      const session = { outputLines: ['retained'], lastReadIndex: 0, lastReadCharacter: 0 };
      if (completed) terminalManager.completedSessions.set(fakePid, { ...session, exitCode });
      else if (state !== 'unknown') terminalManager.sessions.set(fakePid, session);
      return { pid: fakePid, output, isBlocked: !completed };
    };
    const result = enrichStructuredContent('start_process', await startProcess({
      command: `echo completion-state-${state}-${exitCode}`, shell, timeout_ms: 100,
    }));
    assert.equal(result.structuredContent?.isFinished, completed, 'completion must follow process lifecycle');
    assert.equal(result.structuredContent.exitCode, exitCode);
    assert.equal(result.structuredContent.state, state);
    for (const key of outputSchemaForTool('start_process').required) {
      assert(Object.hasOwn(result.structuredContent, key), `advertised schema requires ${key}`);
    }
    assert.equal(result.structuredContent.success, true);
    assert.equal(result.structuredContent.text, result.content[0].text);
    if (completed) assert.match(result.content[0].text, new RegExp(`completed with exit code ${exitCode ?? 'unknown'}`));
    else assert.doesNotMatch(result.content[0].text, /Process finished|Process completed/i);
    const session = (completed ? terminalManager.completedSessions : terminalManager.sessions).get(fakePid);
    if (session) assert.equal(session.lastReadIndex, 0, 'status lookup must not consume output');
    terminalManager.completedSessions.delete(fakePid);
    terminalManager.sessions.delete(fakePid);
  }
  terminalManager.executeCommand = originalExecute;
  // Node may emit exit before the final stdout/stderr data. Only close seals output.
  const originalSpawn = childProcess.spawn;
  try {
    for (const mode of ['completion', 'prompt', 'timeout']) {
      const child = Object.assign(new EventEmitter(), {
        pid: fakePid, stdout: new EventEmitter(), stderr: new EventEmitter(),
      });
      let spawned;
      const spawnReady = new Promise(resolve => { spawned = resolve; });
      childProcess.spawn = () => { spawned(); return child; };
      syncBuiltinESMExports();
      let settled = false;
      const pending = startProcess({
        command: `echo drain-${mode}`, shell, timeout_ms: mode === 'timeout' ? 0 : 60000,
      }).then(result => { settled = true; return result; });
      await spawnReady;
      child.stdout.emit('data', Buffer.from(mode === 'prompt' ? '>>> ' : 'before-exit\n'));
      if (mode !== 'completion') {
        const early = await pending;
        assert.equal(early.structuredContent.isFinished, false);
        assert.equal(early.structuredContent.exitCode, null);
        assert.equal(early.structuredContent.state, mode === 'prompt' ? 'waiting_for_input' : 'running');
      }
      child.emit('exit', 7);
      await Promise.resolve();
      assert.deepEqual(terminalManager.getProcessStatus(fakePid), { isComplete: false, exitCode: null },
        'exit must leave the output session open until stdio drains');
      assert.equal(terminalManager.readOutputPaginated(fakePid, -1, 1).isComplete, false);
      if (mode === 'completion') assert.equal(settled, false, 'completion wait must include stream drain');
      child.stdout.emit('data', Buffer.from('\nfinal-stdout\n'));
      child.stderr.emit('data', Buffer.from('final-stderr\n'));
      child.emit('close', 7);
      const result = await pending;
      assert.deepEqual(terminalManager.getProcessStatus(fakePid), { isComplete: true, exitCode: 7 });
      const retained = terminalManager.readOutputPaginated(fakePid, -5, 5);
      assert.equal(retained.isComplete, true);
      assert.equal(retained.exitCode, 7);
      assert.match(retained.lines.join('\n'), /final-stdout\nfinal-stderr/);
      if (mode === 'completion') {
        assert.equal(result.structuredContent.isFinished, true);
        assert.equal(result.structuredContent.exitCode, 7);
        assert.equal(result.structuredContent.state, 'finished');
        assert.match(result.content[0].text, /final-stdout\nfinal-stderr/);
      }
      terminalManager.completedSessions.delete(fakePid);
    }
  } finally {
    childProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
  }
  const result = await startProcess({ command: 'echo completion-live-check', shell, timeout_ms: 5000 });
  assert.equal(result.structuredContent?.isFinished, true, 'quick command needs no completion poll');
  assert.equal(result.structuredContent.exitCode, 0);
  assert.match(result.content[0].text, /completed with exit code 0/);
  assert(terminalManager.readOutputPaginated(result.structuredContent.pid).lines.join('\n').includes('completion-live-check'));
  console.log('Process start reports authoritative completion without consuming retained output.');
} finally {
  terminalManager.executeCommand = originalExecute;
  terminalManager.completedSessions.delete(fakePid);
  terminalManager.sessions.delete(fakePid);
  env.cleanup();
}
