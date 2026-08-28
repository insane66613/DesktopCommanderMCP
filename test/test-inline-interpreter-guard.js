import assert from 'assert';
import { commandManager } from '../dist/command-manager.js';
import { startProcess } from '../dist/tools/improved-process-tools.js';

const blocked = [
  'python -c "print(1)"',
  'python3 -c "print(1)"',
  'py -c "print(1)"',
  'node -e "console.log(1)"',
  'node --eval "console.log(1)"',
  'node -p "1 + 1"',
  'node --print "1 + 1"',
  "pwsh.exe -NoProfile -Command \"python -c 'print(`danger`)'\"",
  'cmd.exe /c "node -e \'console.log(1)\'"',
  'Write-Output safe; node -e "console.log(1)"',
  'Write-Output safe\npython -c "print(1)"',
  'Write-Output "C:\\temp\\"; python -c "print(1)"',
  'python `\n-c "print(1)"',
  'node --require helper.js -e "console.log(1)"',
  'python -W ignore -c "print(1)"',
];

for (const command of blocked) {
  const reason = commandManager.getUnsafeInlineInterpreterReason(command);
  assert.match(reason ?? '', /inline interpreter/i, `${command} must be recognized as unsafe inline code`);
}

const allowed = [
  'python X:\\work\\patch.py',
  'python -m pytest',
  'python -m pytest -c pyproject.toml',
  'python X:\\work\\patch.py -c literal-script-argument',
  'node X:\\work\\script.js',
  'node X:\\work\\script.js -e literal-script-argument',
  'git commit -m "document python -c quoting hazard"',
  'echo "node -e is intentionally blocked"',
];

for (const command of allowed) {
  assert.strictEqual(
    commandManager.getUnsafeInlineInterpreterReason(command),
    null,
    `${command} must not be rejected by the inline-code guard`,
  );
}

assert.match(
  commandManager.getUnsafeInlineInterpreterReason('node ^\r\n-e "console.log(1)"', 'cmd.exe') ?? '',
  /inline interpreter/i,
  'cmd.exe caret line continuation must not bypass the guard',
);

const launchResult = await startProcess({
  command: `python -c "print('SHOULD_NOT_RUN_${Date.now()}')"`,
  timeout_ms: 1000,
  origin: 'llm',
});

assert.strictEqual(launchResult.isError, true, 'unsafe inline code must fail before process launch');
assert.match(launchResult.content?.[0]?.text ?? '', /Unsafe inline interpreter code/i);
assert.match(launchResult.content?.[0]?.text ?? '', /receive_file/i);
assert.doesNotMatch(launchResult.content?.[0]?.text ?? '', /Process started with PID/i);

console.log('Inline interpreter guard tests passed.');
