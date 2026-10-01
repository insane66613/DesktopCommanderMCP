import assert from 'node:assert/strict';
import { featureFlagManager } from '../dist/utils/feature-flags.js';
import { configManager } from '../dist/config-manager.js';
import { getABTestVariant, hasFeature } from '../dist/utils/ab-test.js';
import { runIfMain } from './helpers/run-if-main.js';

async function runTests() {
  const originalGet = featureFlagManager.get;
  const originalGetValue = configManager.getValue;
  const originalSetValue = configManager.setValue;
  const originalClientId = configManager.getOrCreateClientId;
  const assignments = Object.create(null);
  featureFlagManager.get = (key, fallback) => key === 'experiments'
    ? JSON.parse('{"malformed":{"variants":"bad"},"invalid":{"variants":[null,{"name":1}]},"__proto__":{"variants":[{"name":"safeVariant","weight":1}]}}')
    : fallback;
  configManager.getValue = async (key) => assignments[key];
  configManager.setValue = async (key, value) => { assignments[key] = value; };
  configManager.getOrCreateClientId = async () => 'malformed-regression';
  try {
    assert.equal(await getABTestVariant('malformed'), null);
    assert.equal(await getABTestVariant('invalid'), null);
    assert.equal(await getABTestVariant('__proto__'), 'safeVariant');
    assert.equal(await getABTestVariant('__proto__'), 'safeVariant');
    assert.equal(await hasFeature('safeVariant'), true);
    assert.equal(await hasFeature('unknown'), false);
    console.log('Actual experiment implementation survives malformed neighbors and prototype names.');
  } finally {
    featureFlagManager.get = originalGet;
    configManager.getValue = originalGetValue;
    configManager.setValue = originalSetValue;
    configManager.getOrCreateClientId = originalClientId;
  }
}

runIfMain(import.meta.url, runTests);
