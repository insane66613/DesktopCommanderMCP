import assert from 'assert';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { commandManager } from '../dist/command-manager.js';
import { configManager, normalizeWindowsDefaultShellValue } from '../dist/config-manager.js';
import { terminalManager, WINDOWS_POWERSHELL_7_PATH, resolveWindowsPowerShell7Fallback } from '../dist/terminal-manager.js';
import { getOSSpecificGuidance, getSystemInfo } from '../dist/utils/system-info.js';

const legacy = "& 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' -NoProfile -Command echo bad";
const pwsh = 'pwsh.exe -NoProfile -Command echo ok';
const fullPwshPath = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
const quotedFullPwsh = `& '${fullPwshPath}' -NoProfile -Command echo ok`;
const nestedCmdLegacy = 'cmd /c C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile';
const nestedPwshLegacy = 'pwsh.exe -NoProfile -Command "powershell.exe -NoProfile"';
const literalCommitMessage = 'git commit -m "fix(windows): make PowerShell 7 shell policy durable"';
const literalEcho = 'echo powershell.exe';

async function waitForProcessOutput(pid, pattern, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let output = '';
  while (Date.now() < deadline) {
    const page = terminalManager.readOutputPaginated(pid, 0, 1000);
    if (page) {
      output = page.lines.join('\n');
      if (pattern.test(output) || page.isComplete) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return output;
}

const legacyAllowed = await commandManager.validateCommand(legacy);
const pwshAllowed = await commandManager.validateCommand(pwsh);
const fullPwshAllowed = await commandManager.validateCommand(quotedFullPwsh);
const nestedCmdAllowed = await commandManager.validateCommand(nestedCmdLegacy);
const nestedPwshAllowed = await commandManager.validateCommand(nestedPwshLegacy);
const literalCommitAllowed = await commandManager.validateCommand(literalCommitMessage);
const literalEchoAllowed = await commandManager.validateCommand(literalEcho);
const explicitLegacyShell = await terminalManager.executeCommand(
  'echo SHOULD_NOT_RUN',
  1000,
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
);
const directLegacyCommand = await terminalManager.executeCommand(
  'powershell.exe -NoProfile -Command echo SHOULD_NOT_RUN',
  1000,
  fullPwshPath,
);
const nestedLegacyCommand = await terminalManager.executeCommand(
  nestedCmdLegacy,
  1000,
  fullPwshPath,
);
const legacyViaCmdShell = await terminalManager.executeCommand(
  'powershell.exe -NoProfile -Command echo SHOULD_NOT_RUN',
  1000,
  'cmd.exe',
);

assert.strictEqual(legacyAllowed, false, 'legacy PowerShell command must be rejected');
assert.strictEqual(pwshAllowed, true, 'PowerShell 7 command must remain allowed');
assert.strictEqual(fullPwshAllowed, true, 'PowerShell 7 full path must not be blocked by its PowerShell directory name');
assert.strictEqual(nestedCmdAllowed, false, 'legacy PowerShell nested under cmd must be rejected');
assert.strictEqual(nestedPwshAllowed, false, 'legacy PowerShell nested under pwsh must be rejected');
assert.strictEqual(literalCommitAllowed, true, 'literal PowerShell text in a Git commit message must be allowed');
assert.strictEqual(literalEchoAllowed, true, 'literal powershell.exe text passed to another command must be allowed');
assert.strictEqual(commandManager.isLegacyWindowsPowerShellInvocation(quotedFullPwsh), false);
assert.strictEqual(commandManager.isLegacyWindowsPowerShellInvocation(literalCommitMessage), false);
assert.strictEqual(commandManager.isLegacyWindowsPowerShellInvocation(literalEcho), false);
assert.strictEqual(explicitLegacyShell.pid, -1, 'legacy shell must be rejected before spawn');
assert.match(explicitLegacyShell.output, /Windows PowerShell 5\.1 is disabled/);
assert.strictEqual(directLegacyCommand.pid, -1, 'legacy command must be rejected even under pwsh');
assert.match(directLegacyCommand.output, /Windows PowerShell 5\.1 is disabled/);
assert.strictEqual(nestedLegacyCommand.pid, -1, 'nested legacy command must be rejected at terminal-manager boundary');
assert.match(nestedLegacyCommand.output, /Windows PowerShell 5\.1 is disabled/);
assert.strictEqual(legacyViaCmdShell.pid, -1, 'cmd shell must not bypass legacy PowerShell rejection');
assert.match(legacyViaCmdShell.output, /Windows PowerShell 5\.1 is disabled/);

if (process.platform === 'win32') {
  assert.strictEqual(WINDOWS_POWERSHELL_7_PATH, fullPwshPath);
  assert.strictEqual(resolveWindowsPowerShell7Fallback(), fullPwshPath, 'fallback must resolve the governed PS7 executable');
  const originalGetConfig = configManager.getConfig.bind(configManager);
  configManager.getConfig = async () => { throw new Error('simulated config read failure'); };
  try {
    const fallbackExecution = await terminalManager.executeCommand(
      'Write-Output $PSVersionTable.PSVersion.Major',
      3000,
    );
    assert.notStrictEqual(fallbackExecution.pid, -1, 'config failure must still establish PS7');
    // A login profile may emit startup text and take longer than the initial
    // executeCommand observation window. Verify the eventual process output
    // rather than assuming the version marker is the first line emitted.
    const fallbackOutput = /7/.test(fallbackExecution.output)
      ? fallbackExecution.output
      : await waitForProcessOutput(fallbackExecution.pid, /7/);
    assert.match(fallbackOutput, /7/, 'fallback execution must run under PowerShell 7');
  } finally {
    configManager.getConfig = originalGetConfig;
  }
  assert.strictEqual(normalizeWindowsDefaultShellValue('powershell.exe'), 'pwsh.exe');
  assert.strictEqual(
    normalizeWindowsDefaultShellValue('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'),
    'pwsh.exe',
  );
  assert.strictEqual(normalizeWindowsDefaultShellValue(fullPwshPath), fullPwshPath);

  const guidance = getOSSpecificGuidance(getSystemInfo());
  assert.match(guidance, /Default shell: pwsh\.exe/);
  assert.doesNotMatch(guidance, /Default shell: powershell\.exe/);
}

const setupPath = fileURLToPath(new URL('../setup-claude-server.js', import.meta.url));
const setupSource = await fs.readFile(setupPath, 'utf8');
assert.match(setupSource, /defaultShell: platform\(\) === 'win32' \? 'pwsh\.exe'/);
assert.doesNotMatch(setupSource, /defaultShell: platform\(\) === 'win32' \? 'powershell\.exe'/);
assert.match(setupSource, /"powershell\.exe"/);

console.log('PowerShell 7 enforcement tests passed.');
