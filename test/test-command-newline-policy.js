import assert from 'node:assert/strict';
import { commandManager } from '../dist/command-manager.js';
import { configManager } from '../dist/config-manager.js';
import { startProcess, interactWithProcess } from '../dist/tools/improved-process-tools.js';
import { runIfMain } from './helpers/run-if-main.js';

export default async function runTests() {
  const forbidden = 'blocked-for-tests';
  for (const newline of ['\n', '\r\n', '\r']) {
    const sample = 'Write-Output harmless' + newline + forbidden;
    assert(commandManager.extractCommands(sample).includes(forbidden),
      'an executable after a line break must be checked');
    const blankLines = 'Write-Output harmless' + newline + newline + forbidden;
    assert(commandManager.extractCommands(blankLines).includes(forbidden));
  }
  assert(commandManager.extractCommands('Write-Output "literal\nblocked-for-tests"')
    .every(command => command !== forbidden),
    'newlines inside quoted arguments must not launch phantom commands');
  const literalHere = "Write-Output @'\nblocked-for-tests\n'@\nWrite-Output safe";
  assert(!commandManager.extractCommands(literalHere).includes(forbidden),
    'single-quoted here-string body remains literal');
  const expandedHere = 'Write-Output @"\n$(blocked-for-tests)\n"@\nWrite-Output safe';
  assert(commandManager.extractCommands(expandedHere).includes(forbidden),
    'double-quoted PowerShell here-string executes command substitution');
  if (process.platform === 'win32') {
    assert(commandManager.extractCommands('Write-Output safe\\\nblocked-for-tests').includes(forbidden),
      'PowerShell backslash must not hide a command after newline');
    assert(commandManager.isLegacyWindowsPowerShellInvocation(
      'Write-Output harmless\npowershell.exe -NoProfile'
    ), 'newline cannot hide legacy PowerShell 5.1 invocation');
    assert(commandManager.isLegacyWindowsPowerShellInvocation(
      'cmd /c "echo harmless\npowershell.exe -NoProfile"'
    ), 'nested Windows shell cannot conceal a newline-separated legacy PowerShell invocation');
  }
  const original = await configManager.getConfig();
  try {
    await configManager.setValue('blockedCommands', [forbidden]);
    const multiline = 'Write-Output harmless\n' + forbidden;
    assert.equal(await commandManager.validateCommand(multiline), false);
    const started = await startProcess({ command: multiline, timeout_ms: 1000 });
    assert.equal(started.isError, true, 'start_process must reject blocked newline command');
    assert.match(started.content[0]?.text ?? '', /Command not allowed|blocked command/i);
    const interacted = await interactWithProcess({ pid: 123456789, input: multiline, timeout_ms: 500 });
    assert.equal(interacted.isError, true, 'interact must reject blocked newline command');
    assert.match(interacted.content[0]?.text ?? '', /blocked command/i);
    console.log('PASS: multiline shell policy, here-string quoting and both MCP process handlers');
    return true;
  } finally {
    await configManager.updateConfig(original);
  }
}
runIfMain(import.meta.url, runTests);
