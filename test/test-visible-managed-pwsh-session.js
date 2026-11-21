/** The actual terminal manager, not a direct-spawn fixture, must retain a visible pwsh -NoExit session. */
import assert from 'node:assert/strict';
import { runIfMain } from './helpers/run-if-main.js';

export default async function runTests() {
  if (process.platform !== 'win32') {
    console.log('SKIP: Windows PowerShell 7 managed console lifecycle');
    return;
  }
  const { terminalManager, shouldDetachVisibleShell } = await import('../dist/terminal-manager.js');
  assert.equal(shouldDetachVisibleShell('pwsh.exe', 'win32'), false);
  assert.equal(shouldDetachVisibleShell('C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'win32'), false);
  assert.equal(shouldDetachVisibleShell('cmd.exe', 'win32'), true);
  assert.equal(shouldDetachVisibleShell('/usr/bin/bash', 'linux'), true);
  const title = 'Managed DC [test] "literal" $(Write-Output should-not-run)';
  const command = "Write-Output ('DC_MANAGED_TITLE=' + $Host.UI.RawUI.WindowTitle); Write-Output DC_MANAGED_READY";
  const receipt = await terminalManager.executeCommand(command, 1500, 'pwsh.exe', false, {
    visible: true, keepOpen: true, windowTitle: title,
  });
  assert(receipt.pid > 0, 'Visible managed process failed to start: ' + receipt.output);
  const pid = receipt.pid;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  try {
    let output = receipt.output;
    const readOutput = () => terminalManager.getNewOutput(pid) || '';
    const started = Date.now();
    while (!output.includes('DC_MANAGED_READY') && Date.now() - started < 3500) {
      output += readOutput();
      await delay(100);
    }
    assert(output.includes('DC_MANAGED_TITLE=' + title),
      'Title must appear literally in managed output, no interpolation: ' + output);
    assert(output.includes('DC_MANAGED_READY'), 'Managed startup marker absent: ' + output);
    await delay(450);
    const status = terminalManager.getProcessStatus(pid);
    assert(status && !status.isComplete,
      'A managed visible keep_open session must stay active after command completion');
    assert(terminalManager.getSession(pid), 'Managed persistent session must remain registered');
    const confirmed = await terminalManager.sendInputToProcess(pid, 'exit', 3000);
    assert(confirmed, 'Managed stdin must confirm exit command');
    const until = Date.now() + 5500;
    while (Date.now() < until && !terminalManager.getProcessStatus(pid)?.isComplete) await delay(100);
    assert(terminalManager.getProcessStatus(pid)?.isComplete, 'Managed exit must close console');
    console.log('PASS real managed pwsh keep_open/title readback and interactive exit');
  } finally {
    if (terminalManager.getSession(pid)) await terminalManager.forceTerminateAndWait(pid);
  }
}
runIfMain(import.meta.url, runTests);
