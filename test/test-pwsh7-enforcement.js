import assert from 'assert';
import { commandManager } from '../dist/command-manager.js';
import { terminalManager } from '../dist/terminal-manager.js';

const legacy = "& 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' -NoProfile -Command echo bad";
const pwsh = 'pwsh.exe -NoProfile -Command echo ok';

const legacyAllowed = await commandManager.validateCommand(legacy);
const pwshAllowed = await commandManager.validateCommand(pwsh);
const explicitLegacyShell = await terminalManager.executeCommand(
  'echo SHOULD_NOT_RUN',
  1000,
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
);

assert.strictEqual(legacyAllowed, false, 'legacy PowerShell command must be rejected');
assert.strictEqual(pwshAllowed, true, 'PowerShell 7 command must remain allowed');
assert.strictEqual(explicitLegacyShell.pid, -1, 'legacy shell must be rejected before spawn');
assert.match(explicitLegacyShell.output, /Windows PowerShell 5\.1 is disabled/);

console.log('PowerShell 7 enforcement tests passed.');
