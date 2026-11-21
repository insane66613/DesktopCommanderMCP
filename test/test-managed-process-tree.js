/** Ensure managed shell termination ends its real nested descendants. */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runIfMain, skip } from './helpers/run-if-main.js';

const script = fileURLToPath(import.meta.url);
const mode = process.argv[2];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

if (mode === 'leaf') {
  fs.writeFileSync(process.argv[3], String(process.pid));
  setInterval(() => {}, 1000);
} else if (mode === 'root') {
  const leaf = spawn(process.execPath, [script, 'leaf', process.argv[3]], {
    shell: false, windowsHide: true, stdio: 'ignore',
  });
  fs.writeFileSync(process.argv[4], String(process.pid));
  setInterval(() => {}, 1000);
}

const alive = pid => {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
};
async function waitFor(condition, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) return false;
    await wait(40);
  }
  return true;
}
function cleanup(pid) {
  if (!pid || !alive(pid) || pid === process.pid || pid === process.ppid) return;
  try { process.kill(pid, 'SIGKILL'); } catch {}
}

export default async function runTests() {
  if (process.platform !== 'win32') return skip('Real Windows tree termination requires taskkill.exe');
  const { startProcess, forceTerminate } = await import('../dist/tools/improved-process-tools.js');
  const { killProcess } = await import('../dist/tools/process.js');
  const { terminalManager } = await import('../dist/terminal-manager.js');
  const folder = await fsp.mkdtemp(path.join(os.tmpdir(), 'dc-tree-test-'));
  const results = [];
  try {
    for (const mode of ['kill_process', 'force_terminate']) {
      const leafFile = path.join(folder, mode + '.leaf.pid');
      const rootFile = path.join(folder, mode + '.root.pid');
      let shellPid, rootPid, leafPid;
      try {
        const quote = s => "'" + String(s).replaceAll("'", "''") + "'";
        const command = '& ' + [process.execPath, script, 'root', leafFile, rootFile].map(quote).join(' ');
        const start = await startProcess({ command, shell: 'pwsh.exe', timeout_ms: 800 });
        const text = start.content[0].text;
        shellPid = Number(text.match(/PID (\d+)/)?.[1]);
        assert(Number.isSafeInteger(shellPid) && shellPid > 0, 'start_process must return a real shell PID: ' + text.slice(0, 350));
        assert(await waitFor(() => fs.existsSync(leafFile) && fs.existsSync(rootFile)), mode + ': nested PIDs were not created');
        rootPid = Number(fs.readFileSync(rootFile, 'utf8'));
        leafPid = Number(fs.readFileSync(leafFile, 'utf8'));
        assert(rootPid !== leafPid && rootPid !== shellPid && leafPid !== shellPid,
          mode + ': shell, intermediate parent and leaf must be distinct PIDs');
        assert(alive(shellPid) && alive(rootPid) && alive(leafPid),
          mode + ': all three processes must be alive before test');
        assert(terminalManager.getSession(shellPid), mode + ': root shell must be tracked as a managed session');
        const response = mode === 'kill_process'
          ? await killProcess({ pid: shellPid })
          : await forceTerminate({ pid: shellPid });
        assert(!response.isError, mode + ': ' + response.content[0].text);
        assert(await waitFor(() => !alive(rootPid) && !alive(leafPid)), mode + ': descendants survived termination');
        results.push({ mode, shellPid, rootPid, leafPid, result: response.content[0].text });
        console.log('PASS', mode, 'ended shell, root and leaf', shellPid, rootPid, leafPid);
      } finally {
        cleanup(leafPid);
        cleanup(rootPid);
        if (shellPid && terminalManager.getSession(shellPid)) {
          const child = terminalManager.getSession(shellPid)?.process;
          if (child && child.pid === shellPid) cleanup(shellPid);
        }
      }
    }
    // External PIDs preserve their previous PID-only scope. Automatically
    // ending arbitrary descendants could terminate unrelated processes.
    {
      const leafFile = path.join(folder, 'external.leaf.pid');
      const rootFile = path.join(folder, 'external.root.pid');
      const external = spawn(process.execPath, [script, 'root', leafFile, rootFile], {
        shell: false, windowsHide: true, stdio: 'ignore',
      });
      let leafPid;
      try {
        assert(await waitFor(() => fs.existsSync(leafFile) && fs.existsSync(rootFile)),
          'external nested processes must start');
        leafPid = Number(fs.readFileSync(leafFile, 'utf8'));
        assert.notEqual(external.pid, leafPid);
        assert.equal(terminalManager.getSession(external.pid), undefined, 'external process must not be managed');
        const answer = await killProcess({ pid: external.pid });
        assert(!answer.isError, 'external PID-only termination failed: ' + answer.content[0].text);
        assert(await waitFor(() => !alive(external.pid)), 'external root must terminate');
        assert(alive(leafPid), 'external child must not be killed without explicit ownership');
        console.log('PASS unmanaged PID-only scope, external child left untouched');
      } finally {
        cleanup(leafPid);
        cleanup(external.pid);
      }
    }

    // These are not disposable targets: never allow callers to kill the runtime.
    for (const pid of [process.pid, process.ppid]) {
      const result = await killProcess({ pid });
      assert(result.isError, 'must refuse a runtime/supervisor PID: ' + pid);
    }
    console.log('PASS protected runtime and immediate parent');
    return true;
  } finally {
    await fsp.rm(folder, { recursive: true, force: true });
  }
}
if (mode !== 'root' && mode !== 'leaf') {
  runIfMain(import.meta.url, runTests);
}
