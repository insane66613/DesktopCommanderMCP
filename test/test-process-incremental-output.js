/** Preserve absolute cursors without joining the entire session buffer on polls. */
import assert from 'node:assert/strict';
import { terminalManager } from '../dist/terminal-manager.js';
import { analyzeProcessState } from '../dist/utils/process-detection.js';
import { runIfMain } from './helpers/run-if-main.js';

export default async function runTests() {
  const pid = 700031;
  const lines = ['alpha', 'beta'];
  lines.join = () => { throw new Error('full buffer join is forbidden'); };
  const session = {
    pid, outputLines: lines, bufferedChars: 10, evictedChars: 0,
    evictedLines: 0, generation: 1, outputVersion: 1,
    lifecycleVersion: 0, lastReadIndex: 0, process: { pid },
  };
  terminalManager.sessions.set(pid, session);
  try {
    const first = terminalManager.captureOutputSnapshot(pid);
    assert.deepEqual(first, { totalChars: 10, lineCount: 2 });
    assert.equal(terminalManager.getOutputSinceSnapshot(pid, first), '');
    let cursor = first;
    for (let i = 0; i < 1200; i++) {
      const read = terminalManager.readOutputSince(pid, cursor);
      assert.equal(read.output, '', 'idle poll never builds retained output');
      cursor = read.next;
    }
    lines[1] += '!';
    session.bufferedChars++;
    const appended = terminalManager.readOutputSince(pid, cursor);
    assert.equal(appended.output, '!');
    assert.equal(appended.next.totalChars, 11);
    cursor = appended.next;
    lines.push('tail');
    session.bufferedChars += 5;
    const newLine = terminalManager.readOutputSince(pid, cursor);
    assert.equal(newLine.output, '\ntail');
    assert.equal(newLine.next.totalChars, 16);
    cursor = newLine.next;

    lines.shift();
    session.evictedChars += 6;
    session.evictedLines++;
    session.bufferedChars -= 6;
    assert.equal(terminalManager.readOutputSince(pid, cursor).output, '');
    lines[1] += 'next';
    session.bufferedChars += 4;
    const afterEviction = terminalManager.readOutputSince(pid, cursor);
    assert.equal(afterEviction.output, 'next');
    assert.equal(afterEviction.next.totalChars, 20);
    const oldCursor = { totalChars: 0, lineCount: 0 };
    assert.equal(terminalManager.readOutputSince(pid, oldCursor).output, 'beta!\ntailnext',
      'late cursor receives the retained suffix after eviction');
    const huge = 'B'.repeat(6 * 1024 * 1024);
    lines.length = 0;
    lines.push(huge);
    session.evictedChars = 0;
    session.evictedLines = 0;
    session.bufferedChars = huge.length;
    const hugeCursor = terminalManager.captureOutputSnapshot(pid);
    assert.equal(hugeCursor.totalChars, huge.length);
    assert.equal(terminalManager.readOutputSince(pid, hugeCursor).output, '',
      '6 MiB quiet buffer requires no join');

    assert.equal(analyzeProcessState('Process finished\n' + 'x'.repeat(10000)).isFinished, false,
      'old completion text must not mislabel newer output');
    assert.equal(analyzeProcessState('x'.repeat(10000) + '\n>>> ').isWaitingForInput, true);
    console.log('PASS: O(1) idle snapshots, incremental output, eviction and bounded state detection');
    return true;
  } finally {
    terminalManager.sessions.delete(pid);
  }
}
runIfMain(import.meta.url, runTests);
