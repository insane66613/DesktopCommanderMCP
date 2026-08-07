import assert from 'assert';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { commandManager } from '../dist/command-manager.js';
import { normalizeWindowsDefaultShellValue } from '../dist/config-manager.js';
import { terminalManager } from '../dist/terminal-manager.js';
import { getOSSpecificGuidance, getSystemInfo } from '../dist/utils/system-info.js';

const legacy = "& 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' -NoProfile -Command echo bad";
const pwsh = 'pwsh.exe -NoProfile -Command echo ok';
const fullPwshPath = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
const quotedFullPwsh = `& '${fullPwshPath}' -NoProfile -Command echo ok`;
const nestedCmdLegacy = 'cmd /c C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile';
const nestedPwshLegacy = 'pwsh.exe -NoProfile -Command "powershell.exe -NoProfile"';
const literalCommitMessage = 'git commit -m "fix(windows): make PowerShell 7 shell policy durable"';
const literalEcho = 'echo powershell.exe';

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

if (process.platform === 'win32') {
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
