import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { TrafficClientHarness, evaluateWorkloadMultiRun } from './benchmark-traffic.js';
import { verifyTrafficReports } from './verify-traffic-gate.js';

test('rate uses sorted actual timestamps and half-open rolling windows', () => {
  const harness = new TrafficClientHarness('.');
  harness.records = [60000, 0, 59999, 120000].map(timestamp => ({
    tool: 'get_config', bytes: 100, timestamp, logicalTimestamp: 0,
  }));
  assert.equal(harness.getMetrics(10).peakRatePerMin, 2);
  assert.equal(harness.getMetrics().peakRateBasis, 'observed-call-starts-rolling-60s-half-open');
  harness.records = [];
  assert.equal(harness.getMetrics().peakRatePerMin, 0);
});

test('empty receipts detect legacy and current formats in text and structured content', async () => {
  const harness = new TrafficClientHarness('.');
  const results = [
    { content: [{ type: 'text', text: 'Process running. No new output available.' }] },
    { content: [], structuredContent: { text: 'No new output' } },
    { content: [{ type: 'text', text: '(No output in requested range)' }] },
    { content: [{ type: 'text', text: '[Reading 0 new lines from process]' }] },
    { content: [{ type: 'text', text: 'hello world' }] },
  ];
  harness.client = { callTool: async () => results.shift() };
  for (let i = 0; i < 5; i++) await harness.callTool('read_process_output');
  assert.equal(harness.getMetrics().emptyPolls, 4);
});

test('multi-run config maximum retains an outlier hidden by the median', async () => {
  let run = 0;
  const result = await evaluateWorkloadMultiRun('config accounting', async () => ({
    totalCalls: 3, totalBytes: 4000, totalBytesKiB: '3.91', emptyPolls: 0, peakRatePerMin: 3,
    getConfigDistribution: { p50: 100, max: ++run === 2 ? 3000 : 1000 },
    responseSizeDistribution: { p95: 2000, max: 3000 },
  }));
  assert.equal(result.median.getConfigBytesP50, 100);
  assert.equal(result.worstCase.getConfigBytesMax, 3000);
});

function receipts() {
  const baseline = {};
  const candidate = {
    schemaVersion: 2, evidenceStatus: 'current-synthetic-measurement',
    accountingVersion: 'actual-timestamps-all-empty-receipts-max-config-v2',
    timestamp: new Date().toISOString(),
  };
  for (const workload of ['drain20KiB', 'drain50KiB', 'drain100KiB', 'incidentProfile']) {
    const totalCalls = workload === 'incidentProfile' ? 218 : 4;
    const run = {
      totalCalls, totalBytes: 1000, emptyPolls: 42, peakRatePerMin: totalCalls,
      peakRateBasis: 'observed-call-starts-rolling-60s-half-open', errorCalls: 0,
      callStartTimestamps: Array.from({ length: totalCalls }, (_, index) => 1000 + index),
      responseSizeDistribution: { count: totalCalls, sum: 1000 },
      getConfigDistribution: { count: 16, max: 100 },
    };
    run.emptyPolls = Math.min(totalCalls, run.emptyPolls);
    candidate[workload] = { runs: 3, rawRuns: Array.from({ length: 3 }, () => structuredClone(run)),
      worstCase: { totalBytes: 1000, totalCalls, getConfigBytesMax: 100 } };
    baseline[workload] = { worstCase: { totalBytes: 10000 } };
  }
  return { baseline, candidate };
}

test('synthetic gate does not assert production rate or empty-poll reductions', () => {
  const { baseline, candidate } = receipts();
  const result = verifyTrafficReports(baseline, candidate);
  assert.equal(result.gates.length, 4);
  assert.match(result.limitations, /no production rate or empty-poll reduction/);
});

test('gate rejects missing metrics rather than inventing passing defaults', () => {
  for (const field of ['totalBytes', 'totalCalls', 'peakRatePerMin', 'emptyPolls', 'errorCalls']) {
    const { baseline, candidate } = receipts();
    delete candidate.incidentProfile.rawRuns[0][field];
    assert.throws(() => verifyTrafficReports(baseline, candidate), /Missing or invalid metric/);
  }
});

test('gate rejects forged run counts, summaries, config outliers and tool errors', () => {
  for (const mutate of [
    c => { c.incidentProfile.runs = 4; },
    c => { c.incidentProfile.worstCase.totalBytes = 1; },
    c => { c.incidentProfile.rawRuns[0].getConfigDistribution.max = 3000; },
    c => { c.incidentProfile.rawRuns[0].errorCalls = 1; },
    c => { c.incidentProfile.rawRuns[0].callStartTimestamps = []; },
    c => { c.incidentProfile.rawRuns[0].callStartTimestamps[0] = NaN; },
    c => { c.incidentProfile.rawRuns[0].peakRatePerMin = 10; },
  ]) {
    const { baseline, candidate } = receipts();
    mutate(candidate);
    assert.throws(() => verifyTrafficReports(baseline, candidate));
  }
});

test('archived reports cannot pass current acceptance', () => {
  const baseline = JSON.parse(fs.readFileSync(new URL('./baseline-report.json', import.meta.url)));
  const candidate = JSON.parse(fs.readFileSync(new URL('./hardened-report.json', import.meta.url)));
  assert.equal(candidate.evidenceStatus, 'historical-unverified');
  assert.throws(() => verifyTrafficReports(baseline, candidate), /Current accounting schema v2 receipt required/);
});
