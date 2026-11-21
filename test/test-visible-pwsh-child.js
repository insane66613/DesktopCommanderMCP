/** Real PowerShell 7 startup: window title roundtrip, keep-open and exit. */
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { getShellSpawnArgs } from '../dist/terminal-manager.js';
import { runIfMain } from './helpers/run-if-main.js';

export default async function runTests() {
  if (process.platform !== 'win32') {
    console.log('SKIP Windows-only visible PowerShell console acceptance');
    return;
  }
  const windowTitle = 'DC safe [title] "literal" $(Write-Output never-execute)';
  const command = "Write-Output ('DC_WINDOW_TITLE=' + $Host.UI.RawUI.WindowTitle); Write-Output DC_WINDOW_READY";
  const spec = getShellSpawnArgs('pwsh.exe', command, { visible: true, keepOpen: true, windowTitle });
  const child = spawn(spec.executable, spec.args, {
    env: { ...process.env, DC_WINDOW_TITLE: windowTitle },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  let exited = false;
  child.stdout.on('data', value => { stdout += value.toString(); });
  child.stderr.on('data', value => { stderr += value.toString(); });
  child.once('close', () => { exited = true; });
  child.once('error', error => { stderr += error.message; exited = true; });
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  try {
    const startup = Date.now();
    while (!stdout.includes('DC_WINDOW_READY') && !exited && Date.now() - startup < 7000) {
      await delay(75);
    }
    assert(stdout.includes('DC_WINDOW_READY'), 'PowerShell startup missing: ' + stderr);
    assert(stdout.includes('DC_WINDOW_TITLE=' + windowTitle),
      'PowerShell did not apply the exact literal window title: ' + stdout + stderr);
    await delay(350);
    assert.equal(exited, false, 'NoExit must preserve the console after command completion');
    child.stdin.write('exit\n');
    const ending = Date.now();
    while (!exited && Date.now() - ending < 5000) await delay(75);
    assert(exited, 'Persistent console failed to respond to exit');
    assert(!stderr.includes('Failed to set window title'), stderr);
    console.log('PASS real Windows PowerShell 7 title roundtrip, persistent window, interactive close');
  } finally {
    if (!exited) {
      child.kill();
      child.stdin.destroy();
    }
  }
}
runIfMain(import.meta.url, runTests);
