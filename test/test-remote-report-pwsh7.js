/** Test the real diagnostics process enumerator without calling legacy Windows PowerShell. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { test } from 'node:test';

const source = fs.readFileSync(new URL('../src/remote-device/diagnostics/report.ts', import.meta.url), 'utf8');
const start = source.indexOf('function listProcesses(): Promise<ProcessInfo[]>');
const end = source.indexOf('/** Whether `file`', start);
assert(start >= 0 && end > start, 'the actual diagnostics listProcesses function must exist');
const runnable = ts.transpileModule(source.slice(start, end), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function harness(callback) {
  const calls = [];
  const context = vm.createContext({
    exports: {}, process: { platform: 'win32' }, PROCESS_LIST_TIMEOUT_MS: 30_000,
    execFile: (program, args, options, done) => {
      calls.push({ program, args, options });
      callback(done);
    },
  });
  vm.runInContext(runnable + '\nexports.listProcesses = listProcesses;', context);
  return { calls, listProcesses: context.exports.listProcesses };
}

test('Windows diagnostics use only PowerShell 7 and preserve the complete process identity', async () => {
  const rows = [
    '101\t10\t2026-11-22T10:00:00.000Z\tnode C:/pkg/dist/index.js',
    '102\t101\t2026-11-22T10:01:00.000Z\tnode C:/pkg/dist/index.js\t--keep',
    '0\t0\t2026-11-22T10:02:00.000Z\tnot a process',
  ].join('\n');
  const { calls, listProcesses } = harness((done) => done(null, rows));
  const result = await listProcesses();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].program, 'pwsh.exe');
  assert.deepEqual(Array.from(calls[0].args.slice(0, 3)), ['-NoProfile', '-NonInteractive', '-Command']);
  assert.match(calls[0].args[3], /Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,CommandLine/);
  assert.equal(calls[0].options.timeout, 30_000);
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(result.length, 2);
  assert.equal(result[0].pid, 101);
  assert.equal(result[1].parentPid, 101);
  assert.equal(result[0].startedAt, Date.parse('2026-11-22T10:00:00.000Z'));
  assert.equal(result[1].command, 'node C:/pkg/dist/index.js\t--keep');
});

test('missing pwsh fails clearly and never silently falls back to PowerShell 5.1', async () => {
  const error = Object.assign(new Error('spawn pwsh.exe ENOENT'), { code: 'ENOENT' });
  const { calls, listProcesses } = harness((done) => done(error));
  await assert.rejects(listProcesses(), (actual) => actual.code === 'ENOENT');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].program, 'pwsh.exe');
});
