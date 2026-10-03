#!/usr/bin/env node
/** Synthetic wire-size gates only. Compressed workloads cannot prove production
 * call-rate or empty-poll reductions. Historical reports are comparison material,
 * never current acceptance receipts. */
import fs from 'fs';
import path from 'path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workloads = ['drain20KiB', 'drain50KiB', 'drain100KiB', 'incidentProfile'];

function metric(value, name, minimum = 0) {
  assert(Number.isFinite(value) && Number.isInteger(value) && value >= minimum,
    `Missing or invalid metric: ${name}`);
  return value;
}

export function verifyTrafficReports(baseline, hardened) {
  assert.equal(hardened.schemaVersion, 2, 'Current accounting schema v2 receipt required');
  assert.equal(hardened.evidenceStatus, 'current-synthetic-measurement', 'Historical evidence cannot pass acceptance');
  assert.equal(hardened.accountingVersion, 'actual-timestamps-all-empty-receipts-max-config-v2');
  assert(Number.isFinite(Date.parse(hardened.timestamp)), 'Measurement timestamp required');
  const gates = [];
  for (const workload of workloads) {
    const candidate = hardened[workload];
    assert(candidate && Array.isArray(candidate.rawRuns), `Missing runs: ${workload}`);
    assert.equal(candidate.runs, candidate.rawRuns.length, `Run-count mismatch: ${workload}`);
    assert(candidate.runs >= 3, `At least 3 measured runs required: ${workload}`);
    const raw = candidate.rawRuns;
    for (const [index, run] of raw.entries()) {
      const label = `${workload} run ${index + 1}`;
      metric(run.totalCalls, `${label} totalCalls`, 1);
      metric(run.totalBytes, `${label} totalBytes`, 1);
      metric(run.emptyPolls, `${label} emptyPolls`);
      metric(run.peakRatePerMin, `${label} peakRatePerMin`, 1);
      assert.equal(run.peakRateBasis, 'observed-call-starts-rolling-60s-half-open', `${label} rate measurement basis`);
      assert(Array.isArray(run.callStartTimestamps) && run.callStartTimestamps.length === run.totalCalls,
        `${label} measured call timestamps required`);
      const timestamps = run.callStartTimestamps.map(t => metric(t, `${label} call timestamp`)).sort((a, b) => a - b);
      let peak = 0;
      let end = 0;
      for (let start = 0; start < timestamps.length; start++) {
        while (end < timestamps.length && timestamps[end] < timestamps[start] + 60000) end++;
        peak = Math.max(peak, end - start);
      }
      assert.equal(run.peakRatePerMin, peak, `${label} peak rate must match measured timestamps`);
      assert.equal(metric(run.errorCalls, `${label} errorCalls`), 0, `${label} contains tool errors`);
      assert(run.emptyPolls <= run.totalCalls && run.peakRatePerMin <= run.totalCalls, `${label} inconsistent counts`);
      assert.equal(metric(run.responseSizeDistribution?.count, `${label} response count`), run.totalCalls);
      assert.equal(metric(run.responseSizeDistribution?.sum, `${label} response bytes`), run.totalBytes);
    }
    const worstBytes = Math.max(...raw.map(r => r.totalBytes));
    const worstCalls = Math.max(...raw.map(r => r.totalCalls));
    assert.equal(candidate.worstCase?.totalBytes, worstBytes, `${workload} maximum bytes must match raw runs`);
    assert.equal(candidate.worstCase?.totalCalls, worstCalls, `${workload} maximum calls must match raw runs`);
    const baselineBytes = metric(baseline[workload]?.worstCase?.totalBytes, `${workload} baseline bytes`, 1);
    const byteLimit = Math.floor(baselineBytes * 0.5);
    assert(workload === 'incidentProfile' ? worstBytes < byteLimit : worstBytes <= byteLimit,
      `${workload}: ${worstBytes} bytes exceeds synthetic wire-size target ${byteLimit}`);
    const callLimit = { drain20KiB: 4, drain50KiB: 8, drain100KiB: 14 }[workload];
    assert(raw.every(r => workload === 'incidentProfile' ? r.totalCalls === 218 : r.totalCalls <= callLimit),
      `${workload}: each run must satisfy the call budget`);
    gates.push({ workload, worstBytes, worstCalls, byteLimit });
  }
  const configMax = Math.max(...hardened.incidentProfile.rawRuns.map((run, index) => {
    metric(run.getConfigDistribution?.count, `incident run ${index + 1} config count`, 1);
    return metric(run.getConfigDistribution?.max, `incident run ${index + 1} config max`, 1);
  }));
  assert.equal(hardened.incidentProfile.worstCase?.getConfigBytesMax, configMax, 'Config maximum must match raw maxima');
  assert(configMax < 2048, `Synthetic get_config payload maximum ${configMax} exceeds 2,048 B budget`);
  return { gates, configMax, limitations: 'Synthetic wire-size checks only; no production rate or empty-poll reduction acceptance.' };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const argument = (name, fallback) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
    const baselinePath = argument('baseline', path.join(__dirname, 'baseline-report.json'));
    const hardenedPath = argument('hardened', path.join(__dirname, 'hardened-report.json'));
    const result = verifyTrafficReports(JSON.parse(fs.readFileSync(baselinePath, 'utf8')), JSON.parse(fs.readFileSync(hardenedPath, 'utf8')));
    console.log(JSON.stringify(result, null, 2));
    console.log('PASS: current synthetic wire-size gates. Production scheduling acceptance requires separate live evidence.');
  } catch (error) {
    console.error(`TRAFFIC GATE VERIFICATION FAILED: ${error.message}`);
    process.exitCode = 1;
  }
}
