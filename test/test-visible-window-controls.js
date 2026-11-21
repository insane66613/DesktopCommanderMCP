/** Windows-visible launch controls: no silent hints, shell injection or duplicate launches. */
import assert from 'node:assert/strict';
import { runIfMain } from './helpers/run-if-main.js';

export default async function runTests() {
  const { getShellSpawnArgs, validateWindowLaunchControls } = await import('../dist/terminal-manager.js');
  const { processLaunchAdmission } = await import('../dist/tools/improved-process-tools.js');
  const ordinary = getShellSpawnArgs('pwsh.exe', 'Write-Output "ordinary"');
  assert.deepEqual(ordinary.args, ['-NoLogo', '-NoProfile', '-Command', 'Write-Output "ordinary"']);

  const title = 'Diagnostic "quote"; $(Write-Output injected) [brackets]';
  const options = { visible: true, keepOpen: true, windowTitle: title };
  assert.equal(validateWindowLaunchControls(options, 'pwsh.exe', 'win32'), null);
  const windowed = getShellSpawnArgs('pwsh.exe', 'Write-Output "not altered"', options);
  assert(windowed.args.includes('-NoExit'), 'keep_open requires PowerShell -NoExit');
  assert.equal(windowed.args.at(-1).endsWith('Write-Output "not altered"'), true);
  assert(windowed.args.at(-1).includes('$env:DC_WINDOW_TITLE'));
  assert(!windowed.args.at(-1).includes(title), 'user-controlled window title must not become executable code');

  const once = { command: 'echo visible-control-identity', shell: 'pwsh.exe', visible: true };
  assert.equal(processLaunchAdmission(once).allowed, true);
  assert.equal(processLaunchAdmission({ ...once, keep_open: true }).allowed, true,
    'requested persistent window is a distinct launch');
  assert.equal(processLaunchAdmission({ ...once, window_title: 'Audit' }).allowed, true,
    'requested window title is a distinct launch');
  assert.equal(processLaunchAdmission({ ...once, window_title: 'Audit' }).allowed, false,
    'exact duplicate must still be suppressed');
  assert.equal(validateWindowLaunchControls({ visible: false, keepOpen: true }, 'pwsh.exe', 'win32')?.length > 0, true,
    'no hidden keep_open');
  assert.equal(validateWindowLaunchControls({ visible: false, windowTitle: 'Audit' }, 'pwsh.exe', 'win32')?.length > 0, true,
    'no hidden window_title');
  assert.equal(validateWindowLaunchControls(options, 'cmd.exe', 'win32')?.length > 0, true,
    'unsupported shell must fail closed');
  assert.equal(validateWindowLaunchControls(options, 'pwsh.exe', 'linux')?.length > 0, true,
    'unsupported OS must fail closed');
  for (const invalidTitle of ['', ' ', 'bad\nnext', 'bad\u0000end', 'a'.repeat(129)]) {
    assert.equal(validateWindowLaunchControls({ visible: true, windowTitle: invalidTitle }, 'pwsh.exe', 'win32')?.length > 0, true,
      'invalid title must be rejected');
  }
  const { startProcess } = await import('../dist/tools/improved-process-tools.js');
  const { terminalManager } = await import('../dist/terminal-manager.js');
  const invisible = await startProcess({ command: 'echo invisible-window-check',
    shell: 'pwsh.exe', visible: false, keep_open: true });
  assert.equal(invisible.isError, true, 'hidden keep_open must be rejected before admission');
  const wrongShell = await terminalManager.executeCommand('echo should-not-spawn', 1000,
    'cmd.exe', false, { visible: true, keepOpen: true });
  assert.equal(wrongShell.pid, -1, 'terminal manager must refuse unsupported shells');
  const original = terminalManager.executeCommand;
  let forwarded;
  try {
    terminalManager.executeCommand = async (...args) => {
      forwarded = args[4];
      return { pid: 975310, output: 'stubbed', isBlocked: true };
    };
    const response = await startProcess({ command: 'echo control-forwarding-fixture',
      shell: 'pwsh.exe', visible: true, keep_open: true,
      window_title: 'Safe diagnostic title', timeout_ms: 1 });
    assert.equal(response.isError, undefined);
    assert.equal(forwarded?.visible, true);
    assert.equal(forwarded?.keepOpen, true);
    assert.equal(forwarded?.windowTitle, 'Safe diagnostic title');
  } finally {
    terminalManager.executeCommand = original;
  }
  console.log('PASS Windows pwsh visible keep_open and window_title: effective, injection-safe, admission-safe');
}

runIfMain(import.meta.url, runTests);
