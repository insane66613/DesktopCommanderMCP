import assert from 'node:assert/strict';
import {
  ForceTerminateArgsSchema,
  InteractWithProcessArgsSchema,
  KillProcessArgsSchema,
  ReadFileArgsSchema,
  ReadProcessOutputArgsSchema,
  StartProcessArgsSchema,
} from '../dist/tools/schemas.js';
import { listProcesses } from '../dist/tools/process.js';
import { startProcess as startProcessTool } from '../dist/tools/improved-process-tools.js';

const start = StartProcessArgsSchema.parse({ command: 'echo ok' });
assert.equal(start.timeout_ms, 1000, 'start_process should use the runtime timeout default');

const readFile = ReadFileArgsSchema.parse({ path: 'example.txt' });
assert.equal(readFile.length, undefined, 'read_file should let the handler apply its configured line limit');

for (const schema of [
  ReadProcessOutputArgsSchema,
  InteractWithProcessArgsSchema,
  ForceTerminateArgsSchema,
  KillProcessArgsSchema,
]) {
  for (const pid of [0, -1, 1.5, NaN, Infinity, 2147483648]) {
    const args = schema === InteractWithProcessArgsSchema ? { pid, input: 'x' } : { pid };
    assert.equal(schema.safeParse(args).success, false, `PID ${pid} must be rejected`);
  }
}

if (process.platform === 'win32') {
  const result = await listProcesses();
  assert.equal(result.isError, undefined);
  const text = result.content[0]?.text ?? '';
  assert.doesNotMatch(text, /PID: NaN/);
  assert.match(text, /PID: \d+/);
  assert.match(text, /Command: .+\.exe/i, 'Windows process names should remain intact');

  const invalidShell = await startProcessTool({
    command: 'echo should-not-run',
    timeout_ms: 1000,
    shell: 'X:\\definitely-missing-shell\\pwsh.exe',
  });
  assert.equal(invalidShell.isError, true, 'invalid shell should return a tool error instead of crashing the server');
  assert.match(invalidShell.content[0].text, /ENOENT|not found|failed/i);
}

console.log('PASS: schema defaults, PID guards, and process listing');
