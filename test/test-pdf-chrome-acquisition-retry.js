/**
 * Exercise the actual built Chrome acquisition function with isolated finders.
 * No real Chrome downloads, user cache, network, or production config touched.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const built = fs.readFileSync(new URL('../dist/tools/pdf/markdown.js', import.meta.url), 'utf8');
const start = built.indexOf('async function getChromePath() {');
const end = built.indexOf('export function ensureChromeAvailable()', start);
assert.ok(start >= 0 && end > start, 'Chrome acquisition not found in compiled module');
const source = built.slice(start, end);

function simulatedAcquisition({ system = () => undefined, cached = () => undefined,
  install = async () => undefined, prune = async () => {} } = {}) {
  const context = vm.createContext({
    findSystemChrome: system,
    findPuppeteerChrome: cached,
    installChrome: install,
    pruneOldPuppeteerChromeBuilds: prune,
    console: { error() {} },
  });
  vm.runInContext('let cachedChromePath = null; let chromeCheckPromise = null;\n' +
    source + '\nglobalThis.__getChromePath = getChromePath;', context);
  return context.__getChromePath;
}
// A network failure cannot poison the cache until process restart.
let installs = 0;
let prunes = 0;
const retry = simulatedAcquisition({
  install: async () => {
    installs++;
    if (installs === 1) throw new Error('temporary network interruption');
    return { executablePath: 'mock-chrome.exe' };
  },
  prune: async () => { prunes++; },
});
assert.equal(await retry(), undefined, 'first failed install should return undefined');
assert.equal(await retry(), 'mock-chrome.exe', 'later call must retry and succeed');
assert.equal(await retry(), 'mock-chrome.exe', 'successful path should be cached');
assert.equal(installs, 2, 'failed acquisition must retry but success must not');
assert.equal(prunes, 1, 'only successful install should be pruned');

// Concurrent requests use one installation, not duplicate downloads.
let release;
const gate = new Promise(resolve => { release = resolve; });
let concurrentInstalls = 0;
const shared = simulatedAcquisition({
  install: async () => { concurrentInstalls++; return gate; },
});
const first = shared();
const second = shared();
assert.equal(concurrentInstalls, 1, 'same-flight callers must coalesce');
release({ executablePath: 'shared-chrome.exe' });
assert.deepEqual(await Promise.all([first, second]), ['shared-chrome.exe', 'shared-chrome.exe']);
assert.equal(await shared(), 'shared-chrome.exe');
assert.equal(concurrentInstalls, 1);
// A rejected *discovery* or *cache-pruning* promise must not remain in flight.
let systemCalls = 0;
const transientFinder = simulatedAcquisition({
  system: () => {
    systemCalls++;
    if (systemCalls === 1) throw new Error('transient system lookup');
    return 'system-chrome.exe';
  },
});
await assert.rejects(transientFinder(), /transient system lookup/);
assert.equal(await transientFinder(), 'system-chrome.exe');
assert.equal(systemCalls, 2);

let pruneCalls = 0;
const transientPrune = simulatedAcquisition({
  cached: () => ({ executablePath: 'cached-chrome.exe' }),
  prune: async () => {
    pruneCalls++;
    if (pruneCalls === 1) throw new Error('locked Chrome cache directory');
  },
});
await assert.rejects(transientPrune(), /locked Chrome cache directory/);
assert.equal(await transientPrune(), 'cached-chrome.exe');
assert.equal(pruneCalls, 2);

console.log('PASS: Chrome install retry after failure; successful cache retained');
console.log('PASS: one Chrome install for concurrent first callers');
console.log('PASS: thrown finder/prune does not freeze an in-flight promise');
