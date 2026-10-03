/**
 * DesktopCommanderMCP Synthetic Traffic Workload Profiler Harness
 * 
 * Recreates and evaluates representative agent workloads:
 * - 20 KiB drain workload
 * - 50 KiB drain workload
 * - 100 KiB drain workload
 * - Calibrated Incident-Profile Workload:
 *   218 tool responses matching incident server telemetry (19:30–20:17 CT):
 *   - 83 start_process
 *   - 78 read_process_output (calibrated ~600.6 KiB pre-hardening, P95 ~16.6 KiB)
 *   - 16 get_config (calibrated ~177.9 KiB pre-hardening, ~11.1 KiB each)
 *   - 14 read_file (~47.6 KiB)
 *   -  8 list_sessions (~1.2 KiB)
 *   -  4 read_multiple_files (~33.7 KiB)
 *   -  4 start_search (~3.2 KiB)
 *   -  4 get_more_search_results (~2.3 KiB)
 *   -  2 edit_block (~1.9 KiB)
 *   -  2 write_file (~275 B)
 *   -  1 get_recent_tool_calls (~9.6 KiB)
 *   -  1 get_usage_stats (~1.8 KiB)
 *   -  1 get_file_info (~878 B)
 *   - Observed peak rate: 20 calls/min across 47-min incident window
 * 
 * Evaluates >= 3 runs per workload, reporting Median (P50) and Worst-Case (Max).
 * Actively drains child stderr to eliminate transport backpressure.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createTestEnv } from '../helpers/test-env.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const fixtureConfig = Object.freeze({ processStartOutputLineLimit: 0 });
export const fixtureFingerprint = createHash('sha256').update(JSON.stringify(fixtureConfig)).digest('hex');

export function validateToolReceipt(name, result) {
  if (!result || typeof result !== 'object' || result.isError) {
    throw new Error(`Benchmark ${name} failed: missing result or tool error`);
  }
  if (name === 'start_process') {
    const receipt = result.structuredContent;
    if (receipt?.suppressed === true) {
      if (receipt.pid !== null || !Number.isSafeInteger(receipt.retryAfterMs) || receipt.retryAfterMs <= 0) {
        throw new Error('Benchmark start_process failed: valid suppression receipt required');
      }
    } else {
      requireProcessPid(result);
    }
  }
  if (name === 'start_search') {
    const text = result.content?.filter(c => c.type === 'text').map(c => c.text).join('\n') ?? '';
    const sessionId = result.structuredContent?.sessionId ?? /session:\s*(\S+)/.exec(text)?.[1];
    if (typeof sessionId !== 'string' || !sessionId.trim()) {
      throw new Error('Benchmark start_search failed: sessionId receipt required');
    }
    return sessionId;
  }
}

export function requireProcessPid(result) {
  const processId = result?.structuredContent?.pid;
  if (!Number.isSafeInteger(processId) || processId <= 0) {
    throw new Error('Benchmark start_process failed: valid PID receipt required for dependent workload');
  }
  return processId;
}

function quantile(arr, q) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== undefined) {
    return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  }
  return sorted[base];
}

function stats(arr) {
  if (arr.length === 0) return { count: 0, min: 0, p50: 0, p95: 0, max: 0, sum: 0, mean: 0 };
  const sum = arr.reduce((a, b) => a + b, 0);
  return {
    count: arr.length,
    min: Math.min(...arr),
    p50: Math.round(quantile(arr, 0.5)),
    p95: Math.round(quantile(arr, 0.95)),
    max: Math.max(...arr),
    sum,
    mean: Math.round(sum / arr.length),
  };
}

export class TrafficClientHarness {
  constructor(targetDir, opts = {}) {
    this.targetDir = targetDir;
    this.opts = opts;
    this.client = null;
    this.transport = null;
    this.records = [];
    this.stderrBytes = 0;
    this.stderrChunks = 0;
    this.testEnvironment = null;
    this.failure = null;
  }

  async connect() {
    const serverPath = path.join(this.targetDir, 'dist', 'index.js');
    if (!fs.existsSync(serverPath)) {
      throw new Error(`Server build not found at: ${serverPath}. Run npm run build first.`);
    }

    this.testEnvironment = createTestEnv();
    try {
    // Preserve the target's complete defaults; config-manager treats an existing
    // config as complete rather than merging omitted settings. The child only
    // reads its pure default factory, with identity bound to the isolated home.
    const defaultConfigScript = `
      import { pathToFileURL } from 'node:url';
      const { configManager } = await import(pathToFileURL(process.argv[1]).href);
      console.log(JSON.stringify(configManager.getDefaultConfig()));
    `;
    const defaults = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', defaultConfigScript,
      path.join(this.targetDir, 'dist', 'config-manager.js')], {
      env: { ...this.testEnvironment.env, DESKTOP_COMMANDER_DISABLE_TELEMETRY: '1', DC_FLAG_URL: 'http://127.0.0.1:9/' },
      encoding: 'utf8', windowsHide: true,
    }));
    const configDirectory = path.join(this.testEnvironment.home, '.claude-server-commander');
    fs.mkdirSync(configDirectory, { recursive: true });
    fs.writeFileSync(path.join(configDirectory, 'config.json'), JSON.stringify({ ...defaults, ...fixtureConfig }));
    this.transport = new StdioClientTransport({
      command: process.execPath,
      args: [serverPath, '--no-onboarding'],
      cwd: this.targetDir,
      stderr: 'pipe',
      env: { ...this.testEnvironment.env, NO_COLOR: '1', DESKTOP_COMMANDER_DISABLE_TELEMETRY: '1', DC_FLAG_URL: 'http://127.0.0.1:9/' },
    });

    // CRITICAL: Actively drain transport.stderr to prevent OS pipe buffer backpressure
    this.transport.stderr?.on('data', (chunk) => {
      this.stderrBytes += chunk.length;
      this.stderrChunks++;
    });
    this.transport.stderr?.resume();

    this.client = new Client({ name: 'traffic-benchmark-client', version: '1.0.0' }, { capabilities: {} });
      await this.client.connect(this.transport, { timeout: 30000 });
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async close() {
    if (this.client) {
      try {
        await this.client.close();
      } catch {
        // ignore close errors
      }
    }
    if (this.testEnvironment) {
      this.testEnvironment.cleanup();
      this.testEnvironment = null;
    }
  }

  async callTool(name, args = {}) {
    if (this.failure) throw this.failure;
    const startTime = Date.now();
    let result;
    try {
      result = await this.client.callTool({ name, arguments: args });
    } catch (error) {
      this.failure = error;
      throw error;
    }
    const endTime = Date.now();

    // Serialized MCP response delivered to client (JSON-RPC 2.0 envelope + result)
    const envelope = {
      jsonrpc: '2.0',
      id: this.records.length + 1,
      result,
    };
    const serializedJson = JSON.stringify(envelope);
    const bytes = Buffer.byteLength(serializedJson, 'utf8');

    // Detect empty-poll response
    let isEmptyPoll = false;
    if (name === 'read_process_output') {
      const text = result?.content?.filter(c => c.type === 'text').map(c => c.text).join('\n') ?? '';
      const sc = result?.structuredContent;
      const isNoOutput = text.includes('No new output') || text.includes('(No output in requested range)') ||
                         text.includes('[Reading 0 new lines') || 
                         (sc && sc.text && (sc.text.includes('No new output') || sc.text.includes('(No output in requested range)') || sc.text.includes('[Reading 0 new lines')));
      if (isNoOutput) {
        isEmptyPoll = true;
      }
    }

    const record = {
      tool: name,
      args,
      bytes,
      durationMs: endTime - startTime,
      timestamp: startTime,
      isEmptyPoll,
      isError: !!result?.isError,
      isSuppressedLaunch: name === 'start_process' && result?.structuredContent?.suppressed === true,
    };
    this.records.push(record);
    try {
      validateToolReceipt(name, result);
    } catch (error) {
      record.isError = true;
      this.failure = error;
      throw error;
    }
    return { result, record };
  }

  getMetrics() {
    const totalCalls = this.records.length;
    const allBytes = this.records.map(r => r.bytes);
    const totalBytes = allBytes.reduce((a, b) => a + b, 0);
    const emptyPolls = this.records.filter(r => r.isEmptyPoll).length;

    const getConfigRecords = this.records.filter(r => r.tool === 'get_config');
    const getConfigSizes = getConfigRecords.map(r => r.bytes);

    const readProcessRecords = this.records.filter(r => r.tool === 'read_process_output');
    const readProcessSizes = readProcessRecords.map(r => r.bytes);

    // Peak call frequency: max calls in any rolling 60-second window
    let peakRatePerMin = 0;
    if (this.records.length > 0) {
      const timestamps = this.records.map(r => r.timestamp).sort((a, b) => a - b);
      for (let i = 0; i < timestamps.length; i++) {
        const windowEnd = timestamps[i] + 60000;
        let count = 0;
        for (let j = i; j < timestamps.length && timestamps[j] < windowEnd; j++) {
          count++;
        }
        if (count > peakRatePerMin) peakRatePerMin = count;
      }
    }

    return {
      totalCalls,
      totalBytes,
      totalBytesKiB: (totalBytes / 1024).toFixed(2),
      emptyPolls,
      peakRatePerMin,
      peakRateBasis: 'observed-call-starts-rolling-60s-half-open',
      callStartTimestamps: this.records.map(r => r.timestamp),
      errorCalls: this.records.filter(r => r.isError).length,
      suppressedLaunches: this.records.filter(r => r.isSuppressedLaunch).length,
      stderrBytes: this.stderrBytes,
      stderrChunks: this.stderrChunks,
      responseSizeDistribution: stats(allBytes),
      getConfigDistribution: stats(getConfigSizes),
      readProcessOutputDistribution: stats(readProcessSizes),
      byTool: this.getPerToolStats(),
    };
  }

  getPerToolStats() {
    const toolMap = {};
    for (const r of this.records) {
      if (!toolMap[r.tool]) toolMap[r.tool] = [];
      toolMap[r.tool].push(r.bytes);
    }
    const result = {};
    for (const [tool, sizes] of Object.entries(toolMap)) {
      result[tool] = {
        calls: sizes.length,
        totalBytes: sizes.reduce((a, b) => a + b, 0),
        totalBytesKiB: (sizes.reduce((a, b) => a + b, 0) / 1024).toFixed(2),
        p50: Math.round(quantile(sizes, 0.5)),
        max: Math.max(...sizes),
      };
    }
    return result;
  }
}

/**
 * Runs a single drain test of specified byte count
 */
export async function runDrainWorkload(targetDir, payloadBytes) {
  const harness = new TrafficClientHarness(targetDir);
  await harness.connect();
  try {
    const emitScript = path.join(__dirname, 'emit-bytes.cjs');
    const nodeCmd = `node "${emitScript}" ${payloadBytes}`;

    const { result: startResult } = await harness.callTool('start_process', {
      command: nodeCmd,
      shell: 'cmd.exe',
      timeout_ms: 10000,
    });

    const pid = requireProcessPid(startResult);

    // Drain loop: continue while buffer has more output or was sizeLimited
    let finished = false;
    let iterations = 0;
    while (!finished && iterations < 50) {
      iterations++;
      const { result: readResult } = await harness.callTool('read_process_output', {
        pid,
        timeout_ms: 2000,
      });

      const sc = readResult.structuredContent;
      if (!sc?.sizeLimited && !sc?.hasMoreOutput) {
        finished = true;
      }
    }

    return harness.getMetrics();
  } finally {
    await harness.close();
  }
}

/**
 * Runs the Calibrated Incident-Profile Workload (218 tool responses matching incident telemetry)
 */
export async function runIncidentProfileWorkload(targetDir) {
  const harness = new TrafficClientHarness(targetDir);
  await harness.connect();
  const scratchFile = path.join(os.tmpdir(), `dc-bench-scratch-${process.pid}.txt`);

  try {
    // Generate background generator processes that produce multi-kilobyte streams
    // to replicate the observed ~600.6 KiB read_process_output aggregate and ~16.6 KiB P95 pages
    const emitScript = path.join(__dirname, 'emit-bytes.cjs');
    const bgScript = path.join(__dirname, 'bg-worker.cjs');

    // 1. Long-running background process for empty polls
    const { result: bgPoll } = await harness.callTool('start_process', {
      command: `node "${bgScript}"`,
      shell: 'cmd.exe',
      timeout_ms: 5000,
    });
    const pollPid = requireProcessPid(bgPoll);

    // 2. Large output processes for drain reads (total ~290 KiB raw output -> ~600 KiB serialized in baseline)
    const { result: bgDrain1 } = await harness.callTool('start_process', {
      command: `node "${emitScript}" 145000 1`,
      shell: 'cmd.exe',
      timeout_ms: 10000,
    });
    const drainPid1 = requireProcessPid(bgDrain1);

    const { result: bgDrain2 } = await harness.callTool('start_process', {
      command: `node "${emitScript}" 145000 2`,
      shell: 'cmd.exe',
      timeout_ms: 10000,
    });
    const drainPid2 = requireProcessPid(bgDrain2);

    let startProcessCount = 3; // already called 3 above
    let readProcessCount = 0;
    let getConfigCount = 0;
    let readFileCount = 0;
    let listSessionsCount = 0;
    let readMultipleFilesCount = 0;
    let startSearchCount = 0;
    let getMoreSearchResultsCount = 0;
    let editBlockCount = 0;
    let writeFileSyncCount = 0;
    let getRecentToolCallsCount = 0;
    let getUsageStatsCount = 0;
    let getFileInfoCount = 0;

    let searchSessionId = null;
    let incidentIterations = 0;

    // Exact Target Counts matching Incident Telemetry (Sum = 218):
    // 83 start_process
    // 78 read_process_output
    // 16 get_config
    // 14 read_file
    //  8 list_sessions
    //  4 read_multiple_files
    //  4 start_search
    //  4 get_more_search_results
    //  2 edit_block
    //  2 write_file
    //  1 get_recent_tool_calls
    //  1 get_usage_stats
    //  1 get_file_info

    while (
      startProcessCount < 83 ||
      readProcessCount < 78 ||
      getConfigCount < 16 ||
      readFileCount < 14 ||
      listSessionsCount < 8 ||
      readMultipleFilesCount < 4 ||
      startSearchCount < 4 ||
      getMoreSearchResultsCount < 4 ||
      editBlockCount < 2 ||
      writeFileSyncCount < 2 ||
      getRecentToolCallsCount < 1 ||
      getUsageStatsCount < 1 ||
      getFileInfoCount < 1
    ) {
      if (++incidentIterations > 250) {
        throw new Error('Benchmark incident profile exceeded 250-iteration budget before completing its target counts');
      }
      // 1. get_config (16 calls)
      if (getConfigCount < 16 && (startProcessCount % 5 === 0 || startProcessCount >= 83)) {
        await harness.callTool('get_config', {});
        getConfigCount++;
      }

      // 2. read_file (14 calls)
      if (readFileCount < 14 && (startProcessCount % 6 === 0 || startProcessCount >= 83)) {
        const targetPath = (readFileCount % 2 === 0) ? path.join(targetDir, 'README.md') : path.join(targetDir, 'package.json');
        await harness.callTool('read_file', { path: targetPath, length: 15 });
        readFileCount++;
      }

      // 3. list_sessions (8 calls)
      if (listSessionsCount < 8 && (startProcessCount % 10 === 0 || startProcessCount >= 83)) {
        await harness.callTool('list_sessions', {});
        listSessionsCount++;
      }

      // 4. read_multiple_files (4 calls)
      if (readMultipleFilesCount < 4 && (startProcessCount % 20 === 0 || startProcessCount >= 83)) {
        await harness.callTool('read_multiple_files', {
          paths: [path.join(targetDir, 'package.json'), path.join(targetDir, 'tsconfig.json')],
        });
        readMultipleFilesCount++;
      }

      // 5. start_search (4 calls)
      if (startSearchCount < 4 && (startProcessCount % 20 === 1 || startProcessCount >= 83)) {
        const { result: sr } = await harness.callTool('start_search', {
          path: path.join(targetDir, 'src'),
          pattern: 'config',
        });
        searchSessionId = validateToolReceipt('start_search', sr);
        startSearchCount++;
      }

      // 6. get_more_search_results (4 calls)
      if (getMoreSearchResultsCount < 4 && searchSessionId && (startProcessCount % 20 === 2 || startProcessCount >= 83)) {
        await harness.callTool('get_more_search_results', { sessionId: searchSessionId });
        getMoreSearchResultsCount++;
      }

      // 7. edit_block (2 calls)
      if (editBlockCount < 2 && (startProcessCount >= 40 || startProcessCount >= 83)) {
        fs.writeFileSync(scratchFile, 'initial line 1\ninitial line 2\n');
        await harness.callTool('edit_block', {
          file_path: scratchFile,
          old_string: 'initial line 1',
          new_string: 'updated line 1',
        });
        editBlockCount++;
      }

      // 8. write_file (2 calls)
      if (writeFileSyncCount < 2 && (startProcessCount >= 45 || startProcessCount >= 83)) {
        await harness.callTool('write_file', {
          path: scratchFile,
          content: 'hello scratch content\n',
          mode: 'rewrite',
        });
        writeFileSyncCount++;
      }

      // 9. get_recent_tool_calls (1 call)
      if (getRecentToolCallsCount < 1 && (startProcessCount >= 50 || startProcessCount >= 83)) {
        await harness.callTool('get_recent_tool_calls', { count: 10 });
        getRecentToolCallsCount++;
      }

      // 10. get_usage_stats (1 call)
      if (getUsageStatsCount < 1 && (startProcessCount >= 55 || startProcessCount >= 83)) {
        await harness.callTool('get_usage_stats', {});
        getUsageStatsCount++;
      }

      // 11. get_file_info (1 call)
      if (getFileInfoCount < 1 && (startProcessCount >= 60 || startProcessCount >= 83)) {
        await harness.callTool('get_file_info', { path: path.join(targetDir, 'package.json') });
        getFileInfoCount++;
      }

      // 12. start_process (83 calls total)
      if (startProcessCount < 83) {
        const cmd = `echo step ${startProcessCount}`;
        await harness.callTool('start_process', {
          command: cmd,
          shell: 'cmd.exe',
          timeout_ms: 2000,
        });
        startProcessCount++;
      }

      // 13. read_process_output (78 calls total: 35 drain reads + 43 empty/tail reads)
      if (readProcessCount < 78) {
        if (readProcessCount < 35) {
          // Read full output pages from the drain processes (produces high-volume pages ~16.6 KiB in baseline)
          const targetPid = (readProcessCount % 2 === 0) ? drainPid1 : drainPid2;
          await harness.callTool('read_process_output', { pid: targetPid, timeout_ms: 100 });
        } else {
          // Empty-poll / completion receipts from background process or completed processes
          const targetPid = pollPid || drainPid1;
          await harness.callTool('read_process_output', { pid: targetPid, timeout_ms: 50 });
        }
        readProcessCount++;
      }
    }

    // This compressed synthetic workload measures actual call timestamps. It
    // does not replay the incident timing or establish a production rate.
    return harness.getMetrics();
  } finally {
    if (fs.existsSync(scratchFile)) {
      try { fs.unlinkSync(scratchFile); } catch {}
    }
    await harness.close();
  }
}

/**
 * Multi-run evaluator
 */
export async function evaluateWorkloadMultiRun(workloadName, runnerFn, runs = 3) {
  console.log(`\n==================================================`);
  console.log(`Evaluating ${workloadName} (${runs} runs)...`);
  console.log(`==================================================`);

  const results = [];
  for (let r = 1; r <= runs; r++) {
    console.log(`  Run ${r}/${runs}...`);
    const metrics = await runnerFn();
    results.push(metrics);
    console.log(`    Calls: ${metrics.totalCalls}, Total Bytes: ${metrics.totalBytes} (${metrics.totalBytesKiB} KiB), Empty Polls: ${metrics.emptyPolls}`);
  }

  const callsArr = results.map(r => r.totalCalls);
  const bytesArr = results.map(r => r.totalBytes);
  const emptyArr = results.map(r => r.emptyPolls);
  const peakArr = results.map(r => r.peakRatePerMin);
  const getConfigSizesArr = results.map(r => r.getConfigDistribution.p50);
  const getConfigMaxSizesArr = results.map(r => r.getConfigDistribution.max);
  const p95SizesArr = results.map(r => r.responseSizeDistribution.p95);
  const maxSizesArr = results.map(r => r.responseSizeDistribution.max);

  const summary = {
    workload: workloadName,
    runs,
    median: {
      totalCalls: Math.round(quantile(callsArr, 0.5)),
      totalBytes: Math.round(quantile(bytesArr, 0.5)),
      totalBytesKiB: (quantile(bytesArr, 0.5) / 1024).toFixed(2),
      emptyPolls: Math.round(quantile(emptyArr, 0.5)),
      peakRatePerMin: Math.round(quantile(peakArr, 0.5)),
      getConfigBytesP50: Math.round(quantile(getConfigSizesArr, 0.5)),
      responseBytesP95: Math.round(quantile(p95SizesArr, 0.5)),
      responseBytesMax: Math.round(quantile(maxSizesArr, 0.5)),
    },
    worstCase: {
      totalCalls: Math.max(...callsArr),
      totalBytes: Math.max(...bytesArr),
      totalBytesKiB: (Math.max(...bytesArr) / 1024).toFixed(2),
      emptyPolls: Math.max(...emptyArr),
      peakRatePerMin: Math.max(...peakArr),
      getConfigBytesMax: Math.max(...getConfigMaxSizesArr),
      responseBytesMax: Math.max(...maxSizesArr),
    },
    rawRuns: results,
  };

  console.log(`  --> Median Total Bytes: ${summary.median.totalBytes} (${summary.median.totalBytesKiB} KiB)`);
  console.log(`  --> Worst-Case Total Bytes: ${summary.worstCase.totalBytes} (${summary.worstCase.totalBytesKiB} KiB)`);
  console.log(`  --> Median Calls: ${summary.median.totalCalls}, Empty Polls: ${summary.median.emptyPolls}`);
  return summary;
}

export async function runAllBenchmarks(targetDir, runs = 3) {
  const report = {
    schemaVersion: 2,
    evidenceStatus: 'current-synthetic-measurement',
    workloadTiming: 'compressed-synthetic; no production call-rate or empty-poll reduction claim',
    accountingVersion: 'actual-timestamps-all-empty-receipts-max-config-v2',
    fixtureConfig,
    fixtureFingerprint,
    sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: targetDir, encoding: 'utf8', windowsHide: true }).trim(),
    targetDir,
    timestamp: new Date().toISOString(),
    drain20KiB: await evaluateWorkloadMultiRun('20 KiB Drain Workload', () => runDrainWorkload(targetDir, 20480), runs),
    drain50KiB: await evaluateWorkloadMultiRun('50 KiB Drain Workload', () => runDrainWorkload(targetDir, 51200), runs),
    drain100KiB: await evaluateWorkloadMultiRun('100 KiB Drain Workload', () => runDrainWorkload(targetDir, 102400), runs),
    incidentProfile: await evaluateWorkloadMultiRun('Incident Profile Workload (218 calls)', () => runIncidentProfileWorkload(targetDir), runs),
  };
  return report;
}

// CLI execution
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const targetArg = process.argv.find(a => a.startsWith('--target='));
  const defaultTarget = fs.existsSync(path.resolve(__dirname, '..', '..', 'dist', 'index.js')) 
    ? path.resolve(__dirname, '..', '..') 
    : path.resolve(__dirname, '..', '..', '..');
  const targetDir = targetArg ? targetArg.split('=')[1] : (process.env.BENCHMARK_TARGET_DIR || defaultTarget);
  const runsArg = process.argv.find(a => a.startsWith('--runs='));
  const runs = runsArg ? parseInt(runsArg.split('=')[1], 10) : 3;
  const outputArg = process.argv.find(a => a.startsWith('--output='));
  const defaultOutPath = path.join(__dirname, 'hardened-report.json');
  const outPath = outputArg 
    ? (path.isAbsolute(outputArg.split('=')[1]) ? outputArg.split('=')[1] : path.resolve(process.cwd(), outputArg.split('=')[1]))
    : defaultOutPath;

  console.log(`Traffic Hardening Profiler Harness`);
  console.log(`Target: ${targetDir}`);
  console.log(`Runs per workload: ${runs}`);
  console.log(`Output: ${outPath}`);

  runAllBenchmarks(targetDir, runs).then((report) => {
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
    console.log(`\nBenchmark complete. Full report written to: ${outPath}`);
  }).catch((err) => {
    console.error('Benchmark failed:', err);
    process.exit(1);
  });
}
