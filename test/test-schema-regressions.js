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
import { startProcess as startProcessTool, interactWithProcess, forceTerminate } from '../dist/tools/improved-process-tools.js';

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

// Virtual node:local PIDs are negative application-owned IDs, not OS PIDs.
for (const schema of [InteractWithProcessArgsSchema, ForceTerminateArgsSchema]) {
  const input = schema === InteractWithProcessArgsSchema ? { pid: -1000, input: '1 + 1' } : { pid: -1000 };
  assert.equal(schema.safeParse(input).success, true, 'virtual node:local PID must remain addressable');
  assert.equal(schema.safeParse({ ...input, pid: -999 }).success, false);
}
for (const schema of [ReadProcessOutputArgsSchema, KillProcessArgsSchema]) {
  assert.equal(schema.safeParse({ pid: -1000 }).success, false, 'OS-only tools must reject virtual PIDs');
}

// Execute a real virtual-session lifecycle through the same public handlers.
const virtualStarted = await startProcessTool({ command: 'node:local', timeout_ms: 5000 });
assert.notEqual(virtualStarted.isError, true, 'node:local must launch a virtual session');
const virtualPid = Number(virtualStarted.content[0].text.match(/PID (-\d+)/)?.[1]);
assert(Number.isSafeInteger(virtualPid) && virtualPid <= -1000);
try {
  const result = await interactWithProcess({ pid: virtualPid, input: "console.log('NODE_LOCAL_SCHEMA_OK')", timeout_ms: 5000 });
  assert.notEqual(result.isError, true, result.content?.[0]?.text ?? 'virtual interaction failed');
  assert.match(result.content.map(x => x.text ?? '').join('\\n'), /NODE_LOCAL_SCHEMA_OK/);
} finally {
  const closed = await forceTerminate({ pid: virtualPid });
  assert.notEqual(closed.isError, true, 'virtual session termination must work');
}
const missing = await forceTerminate({ pid: virtualPid });
assert.equal(missing.isError, true, 'already-closed virtual session must fail closed');

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
