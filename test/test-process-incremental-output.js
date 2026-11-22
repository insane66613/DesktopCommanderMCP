/** Preserve absolute cursors without joining the entire session buffer on polls. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { interactWithProcess } from '../dist/tools/improved-process-tools.js';
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
    assert.deepEqual(first, { totalChars: 10, lineCount: 2, generation: 1 });
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
    const oldCursor = { totalChars: 0, lineCount: 0, generation: 1 };
    assert.equal(terminalManager.readOutputSince(pid, oldCursor).output, 'beta!\ntailnext',
      'late cursor receives the retained suffix after eviction');
    // A recycled PID must never allow the old generation to observe new output.
    const replacement = {
      ...session, generation: 2, outputLines: ['replacement process secret'],
      bufferedChars: 26, evictedChars: 0, evictedLines: 0,
    };
    terminalManager.sessions.set(pid, replacement);
    assert.equal(terminalManager.readOutputSince(pid, oldCursor), null,
      'a cursor from generation 1 must reject generation 2 under the same PID');
    assert.equal(terminalManager.getOutputSinceSnapshot(pid, first), null);
    const replacementCursor = terminalManager.captureOutputSnapshot(pid);
    assert.equal(replacementCursor.generation, 2);
    const delivered = [];
    const stdin = new EventEmitter();
    stdin.writable = true;
    stdin.destroyed = false;
    stdin.writableEnded = false;
    stdin.write = (value, callback) => { delivered.push(value); callback(); return true; };
    replacement.process = { pid, stdin };
    assert.equal(await terminalManager.sendInputToProcess(pid, 'sensitive', 300, first.generation), false);
    assert.equal(delivered.length, 0, 'stale generation cannot receive private input');
    assert.equal(await terminalManager.sendInputToProcess(pid, 'valid', 300, 2), true);
    assert.deepEqual(delivered, ['valid\n'], 'matching generation still accepts input');

    terminalManager.sessions.set(pid, session);
    const originalCapture = terminalManager.captureOutputSnapshot;
    try {
      terminalManager.captureOutputSnapshot = function(id) {
        const captured = originalCapture.call(this, id);
        terminalManager.sessions.set(id, replacement); // PID reused between snapshot and send.
        return captured;
      };
      const before = delivered.length;
      const response = await interactWithProcess({ pid, input: 'intercepted secret', timeout_ms: 300 });
      assert.equal(response.isError, true, 'interaction must reject replaced PID');
      assert.equal(delivered.length, before, 'interact_with_process must not write to the replacement');
    } finally {
      terminalManager.captureOutputSnapshot = originalCapture;
      terminalManager.sessions.set(pid, session);
    }

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
