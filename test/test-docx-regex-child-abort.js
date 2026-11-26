import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { SearchManager } from '../dist/search-manager.js';

const originalSpawn = childProcess.spawn;
const manager = new SearchManager();
let slowChild = null;
try {
  childProcess.spawn = (cmd, args, options) => {
    if (args.includes('--no-config') && args.includes('--json')) {
      slowChild = originalSpawn(process.execPath,
        ['-e', 'process.stdin.resume();setInterval(()=>{},1000)'], options);
      return slowChild;
    }
    return originalSpawn(cmd, args, options);
  };
  syncBuiltinESMExports();
  const controller = new AbortController();
  const task = manager.matchDocxRegexCells(
    [{text:'DOCX regex cancellation',file:'one.docx',line:1}],
    'cancellation', true, 10, controller.signal);
  const deadline = Date.now() + 3000;
  while (!slowChild && Date.now() < deadline)
    await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(slowChild?.pid, 'real controlled subprocess must start');
  const exit = new Promise(resolve => {
    if (slowChild.exitCode !== null) resolve();
    else slowChild.once('close', resolve);
  });
  controller.abort();
  await assert.rejects(task, /aborted/i);
  await Promise.race([exit, new Promise((_,reject) =>
    setTimeout(() => reject(Error('child did not terminate')), 3000))]);
  assert.equal(slowChild.killed,true,'cancellation must signal owned subprocess');
  console.log('PASS: session AbortSignal terminates a real active DOCX regex child');
} finally {
  childProcess.spawn = originalSpawn;
  syncBuiltinESMExports();
  if (slowChild?.exitCode === null) slowChild.kill();
  manager.dispose();
}
