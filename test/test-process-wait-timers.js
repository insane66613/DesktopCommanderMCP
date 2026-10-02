import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createTestEnv } from './helpers/test-env.js';

if (!process.env.DC_WAIT_TIMER_TEST_CHILD) {
  const env = createTestEnv();
  try {
    const child = spawnSync(process.execPath, [import.meta.filename], {
      env: { ...env.env, DC_WAIT_TIMER_TEST_CHILD: '1' },
      stdio: 'inherit', timeout: 8000,
    });
    assert.ifError(child.error);
    assert.equal(child.status, 0, 'quick exit must not retain the 60-second start timeout');
  } finally { env.cleanup(); }
} else {
  const { terminalManager, TerminalManager } = await import('../dist/terminal-manager.js');
  const { readProcessOutput } = await import('../dist/tools/improved-process-tools.js');
  const { configManager } = await import('../dist/config-manager.js');
  await configManager.getConfig();

  // Fake only the output-wait clock. No subprocess or configuration work runs
  // while these replacements are installed.
  const originalNow = Date.now;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const pid = 987654;
  terminalManager.sessions.set(pid, { outputLines: [], lastReadIndex: 0,
    lastReadCharacter: 0, startTime: new Date(), bufferedChars: 0 });
  try {
    for (const timeout of [0, 5, 1000]) {
      let clock = 1000;
      const deadline = clock + timeout;
      let ticks = 0;
      Date.now = () => clock;
      globalThis.setTimeout = (callback, delay) => {
        assert(delay <= deadline - clock, `timer ${delay} exceeds remaining ${deadline - clock} ms`);
        assert(++ticks < 100, 'output wait must remain bounded');
        clock += delay;
        queueMicrotask(callback);
        return 1;
      };
      globalThis.clearTimeout = () => {};
      const result = await readProcessOutput({ pid, timeout_ms: timeout });
      assert.equal(result.structuredContent.success, true);
      assert.equal(clock, deadline, 'empty-output wait ends at its deadline');
      if (timeout === 0) assert.equal(ticks, 0);
    }
  } finally {
    Date.now = originalNow;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    terminalManager.sessions.delete(pid);
  }

  const manager = new TerminalManager();
  const shell = process.platform === 'win32' ? 'pwsh.exe' : '/bin/sh';
  const result = await manager.executeCommand('echo timer-cleanup-ok', 60000, shell);
  assert(result.pid > 0);
  // Exiting naturally is part of the assertion: do not call process.exit().
  console.log('Process wait deadlines and quick-exit timeout cleanup passed.');
}
