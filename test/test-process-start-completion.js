import assert from 'node:assert/strict';
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
