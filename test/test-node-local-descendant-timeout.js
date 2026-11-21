/** Ensure node:local timeouts end descendant processes holding inherited pipes. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runIfMain, skip } from './helpers/run-if-main.js';
import { startProcess, interactWithProcess, forceTerminate } from '../dist/tools/improved-process-tools.js';

const alive = pid => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
};
const kill = pid => {
  if (!alive(pid) || pid === process.pid || pid === process.ppid) return;
  spawnSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
    ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 6000 });
};
export default async function runTests() {
  if (process.platform !== 'win32') return skip('Windows taskkill tree regression');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dc-node-local-tree-'));
  const rootFile = path.join(dir, 'root.pid');
  const leafFile = path.join(dir, 'leaf.pid');
  let sessionPid, rootPid, leafPid;
  try {
    const start = await startProcess({ command: 'node:local', timeout_ms: 1400 });
    sessionPid = Number(start.content[0].text.match(/PID (-\d+)/)?.[1]);
    assert(sessionPid < 0, 'node:local session did not start');
    const source = [
      "import { spawn } from 'node:child_process';",
      "import fs from 'node:fs';",
      "const leaf = spawn(process.execPath, ['-e', 'setInterval(() => {}, 300)'], { stdio: 'inherit', windowsHide: true });",
      `fs.writeFileSync(${JSON.stringify(rootFile)}, String(process.pid));`,
      `fs.writeFileSync(${JSON.stringify(leafFile)}, String(leaf.pid));`,
      "setInterval(() => {}, 300);",
    ].join('\n');
    const started = Date.now();
    let deadline;
    const answer = await Promise.race([
      interactWithProcess({ pid: sessionPid, input: source, timeout_ms: 1400 }),
      new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new Error('node:local did not answer within 9 seconds')), 9000);
      }),
    ]).finally(() => clearTimeout(deadline));
    const elapsed = Date.now() - started;
    rootPid = Number(await fsp.readFile(rootFile, 'utf8'));
    leafPid = Number(await fsp.readFile(leafFile, 'utf8'));
    assert(rootPid > 0 && leafPid > 0 && rootPid !== leafPid);
    assert(answer.isError, 'timed-out code must return an error');
    assert.match(answer.content[0].text, /Execution timed out after 1400ms/);
    assert(elapsed < 9000, `timeout took ${elapsed}ms`);
    assert(!alive(rootPid) && !alive(leafPid),
      `script and inherited-pipe descendant must end (root=${rootPid}, leaf=${leafPid})`);
    console.log('PASS node:local timeout ended root and descendant after', elapsed, 'ms');
    const success = await interactWithProcess({
      pid: sessionPid, input: "console.log('node-local-ok')", timeout_ms: 3000,
    });
    assert(!success.isError && success.content[0].text.trim() === 'node-local-ok',
      'normal node:local script must still work');
    console.log('PASS normal node:local output remains available');
    return true;
  } finally {
    kill(rootPid);
    kill(leafPid);
    if (sessionPid) await forceTerminate({ pid: sessionPid });
    await fsp.rm(dir, { recursive: true, force: true });
  }
}
runIfMain(import.meta.url, runTests);
