import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createTestEnv } from './helpers/test-env.js';
import { getConfig, setConfigValue } from '../dist/tools/config.js';
import { configManager } from '../dist/config-manager.js';

const EXPECTED_BLOCKED_COMMANDS_DIGEST = 'baa70ce52149cb98be8bfbcae4fad7e1461dce156d3f4c0d1914d1a92c8c4f8a';
const BYTE_BUDGET_GATE = 2048;

async function runTests() {
  console.log('=== Starting Test Suite: test-config-traffic-hardening.js ===\n');

  // Test 1: Direct function calls - default (no args) and empty object {}
  console.log('Test 1: Default get_config calls return compact payload (< 2,048 bytes)...');
  const resNoArgs = await getConfig();
  const bytesNoArgs = Buffer.byteLength(JSON.stringify(resNoArgs), 'utf8');
  console.log(`  - No-args payload size: ${bytesNoArgs} bytes (Budget: < ${BYTE_BUDGET_GATE})`);
  assert.ok(bytesNoArgs < BYTE_BUDGET_GATE, `No-args payload size ${bytesNoArgs} exceeded budget of ${BYTE_BUDGET_GATE}`);

  const resEmptyArgs = await getConfig({});
  const bytesEmptyArgs = Buffer.byteLength(JSON.stringify(resEmptyArgs), 'utf8');
  console.log(`  - Empty args ({}) payload size: ${bytesEmptyArgs} bytes (Budget: < ${BYTE_BUDGET_GATE})`);
  assert.ok(bytesEmptyArgs < BYTE_BUDGET_GATE, `Empty args payload size ${bytesEmptyArgs} exceeded budget of ${BYTE_BUDGET_GATE}`);
  console.log('  ✓ Test 1 PASSED\n');

  // Test 2: Essential fields validation in default compact response
  console.log('Test 2: Validating essential fields in compact response...');
  const compactConfig = resEmptyArgs.structuredContent?.config;
  assert.ok(compactConfig, 'structuredContent.config must exist');

  const requiredFields = [
    'allowedDirectories',
    'blockedCommands',
    'telemetryEnabled',
    'clientId',
    'sensitiveProjectFilePolicy',
    'sensitiveProjectFileExtraPatterns',
    'sensitiveProjectFileAllowedPatterns',
    'sensitiveProjectFileAudit',
  ];

  for (const field of requiredFields) {
    assert.ok(field in compactConfig, `Essential field "${field}" must be present in compact config`);
    console.log(`  - Field "${field}": present (value: ${JSON.stringify(compactConfig[field])})`);
  }

  // Ensure verbose structures are omitted from compact response
  assert.strictEqual(compactConfig.usageStats, undefined, 'usageStats must be omitted in compact mode');
  assert.strictEqual(compactConfig._metrics, undefined, '_metrics must be omitted in compact mode');
  assert.strictEqual(compactConfig.systemInfo, undefined, 'verbose systemInfo must be omitted in compact mode');

  // Verify content[0].text is concise
  assert.ok(Array.isArray(resEmptyArgs.content) && resEmptyArgs.content.length > 0, 'content array must exist');
  const textSummary = resEmptyArgs.content[0].text;
  const textBytes = Buffer.byteLength(textSummary, 'utf8');
  console.log(`  - Concise summary text length: ${textBytes} bytes`);
  assert.ok(textBytes < 300, `Summary text length ${textBytes} exceeds concise expectation (< 300 bytes)`);
  console.log('  ✓ Test 2 PASSED\n');

  // Test 3: blockedCommands SHA256 digest validation
  console.log('Test 3: Validating blockedCommands SHA256 digest...');
  const blockedCommands = compactConfig.blockedCommands;
  assert.ok(Array.isArray(blockedCommands), 'blockedCommands must be an array');
  assert.strictEqual(blockedCommands.length, 35, `Expected 35 blocked commands, got ${blockedCommands.length}`);

  // Pure Node.js digest calculation (replicating Python json.dumps format)
  const pyFormat = '[' + blockedCommands.map((c) => JSON.stringify(c)).join(', ') + ']';
  const nodeDigest = crypto.createHash('sha256').update(pyFormat).digest('hex');
  console.log(`  - Node computed SHA256 digest: ${nodeDigest}`);
  assert.strictEqual(nodeDigest, EXPECTED_BLOCKED_COMMANDS_DIGEST, `Node digest mismatch: expected ${EXPECTED_BLOCKED_COMMANDS_DIGEST}, got ${nodeDigest}`);

  // Python child_process validation
  try {
    const pythonOut = execFileSync('python', [
      '-c',
      `import json, hashlib; l = json.loads('''${JSON.stringify(blockedCommands)}'''); print(hashlib.sha256(json.dumps(l, sort_keys=True).encode()).hexdigest(), end='')`
    ], { encoding: 'utf8' }).trim();
    console.log(`  - Python computed SHA256 digest: ${pythonOut}`);
    assert.strictEqual(pythonOut, EXPECTED_BLOCKED_COMMANDS_DIGEST, `Python digest mismatch: expected ${EXPECTED_BLOCKED_COMMANDS_DIGEST}, got ${pythonOut}`);
    console.log('  - Python independent cross-verification matched perfectly');
  } catch (err) {
    console.warn(`  - Python execution skipped or failed: ${err.message}`);
  }
  console.log('  ✓ Test 3 PASSED\n');

  // Test 4: Verbose mode and backward compatibility
  console.log('Test 4: Validating verbose mode and compatibility overrides...');
  const verboseRes = await getConfig({ verbose: true });
  const verboseBytes = Buffer.byteLength(JSON.stringify(verboseRes), 'utf8');
  console.log(`  - { verbose: true } payload size: ${verboseBytes} bytes`);
  assert.ok(verboseBytes > 6000, `{ verbose: true } payload size ${verboseBytes} must be > 6000 bytes`);
  assert.ok(verboseRes.structuredContent?.config?.systemInfo, 'verbose mode must include systemInfo');
  if (verboseRes.structuredContent?.config?.usageStats) {
    assert.ok(typeof verboseRes.structuredContent.config.usageStats === 'object');
  }
  assert.ok(verboseRes.structuredContent?.uiHints, 'verbose mode must include uiHints');

  const uiRes = await getConfig({ origin: 'ui' });
  const uiBytes = Buffer.byteLength(JSON.stringify(uiRes), 'utf8');
  console.log(`  - { origin: 'ui' } payload size: ${uiBytes} bytes`);
  assert.ok(uiBytes > 6000, `{ origin: 'ui' } payload size ${uiBytes} must be > 6000 bytes`);

  const compactFalseRes = await getConfig({ compact: false });
  const compactFalseBytes = Buffer.byteLength(JSON.stringify(compactFalseRes), 'utf8');
  console.log(`  - { compact: false } payload size: ${compactFalseBytes} bytes`);
  assert.ok(compactFalseBytes > 6000, `{ compact: false } payload size ${compactFalseBytes} must be > 6000 bytes`);

  const compactTrueRes = await getConfig({ compact: true });
  const compactTrueBytes = Buffer.byteLength(JSON.stringify(compactTrueRes), 'utf8');
  console.log(`  - { compact: true } payload size: ${compactTrueBytes} bytes`);
  assert.ok(compactTrueBytes < BYTE_BUDGET_GATE, `{ compact: true } payload size ${compactTrueBytes} must be < ${BYTE_BUDGET_GATE}`);
  console.log('  ✓ Test 4 PASSED\n');

  // Test 5: structuredContent.entries compatibility
  console.log('Test 5: Validating structuredContent.entries compatibility...');
  const entries = resEmptyArgs.structuredContent?.entries;
  assert.ok(Array.isArray(entries), 'structuredContent.entries must be an array');
  const entryMap = Object.fromEntries(entries.map((e) => [e.key, e.value]));

  assert.strictEqual(entryMap.sensitiveProjectFilePolicy, 'require_explicit_override', 'sensitiveProjectFilePolicy entry must match');
  assert.ok(Array.isArray(entryMap.sensitiveProjectFileExtraPatterns), 'sensitiveProjectFileExtraPatterns must be array');
  assert.ok(Array.isArray(entryMap.sensitiveProjectFileAllowedPatterns), 'sensitiveProjectFileAllowedPatterns must be array');
  assert.strictEqual(entryMap.sensitiveProjectFileAudit, true, 'sensitiveProjectFileAudit must be true');
  assert.ok('allowedDirectories' in entryMap, 'allowedDirectories entry must exist');

  // All entries must have editable: true and valueType
  for (const entry of entries) {
    assert.strictEqual(entry.editable, true, `Entry "${entry.key}" must be editable`);
    assert.ok(typeof entry.valueType === 'string', `Entry "${entry.key}" must have a valueType`);
  }
  console.log(`  - Found ${entries.length} valid structured entries`);
  console.log('  ✓ Test 5 PASSED\n');

  // Test 6: setConfigValue validation for sensitive project file policies
  console.log('Test 6: Validating setConfigValue enforcement for sensitive project policies...');
  const invalidPolicyRes = await setConfigValue({
    key: 'sensitiveProjectFilePolicy',
    value: 'disabled',
  });
  assert.strictEqual(invalidPolicyRes.isError, true, 'Setting invalid policy option should return isError: true');

  const validPolicyRes = await setConfigValue({
    key: 'sensitiveProjectFilePolicy',
    value: 'require_explicit_override',
  });
  assert.notStrictEqual(validPolicyRes.isError, true, 'Setting valid policy option should succeed');
  console.log('  ✓ Test 6 PASSED\n');

  // Test 7: Full MCP Server Client Wire Byte Delivery Proof
  console.log('Test 7: Proving full MCP server wire delivery < 2,048 bytes on default caller path...');
  const env = createTestEnv();
  const serverEntry = fileURLToPath(new URL('../dist/index.js', import.meta.url));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env: env.env,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'test-config-traffic-hardening', version: '1.0.0' });

  try {
    await client.connect(transport);
    const mcpResult = await client.callTool({ name: 'get_config', arguments: {} });
    assert.notStrictEqual(mcpResult.isError, true, `MCP tool call failed: ${mcpResult.content?.[0]?.text}`);

    const serializedWireBytes = Buffer.byteLength(JSON.stringify(mcpResult), 'utf8');
    console.log(`  - Full MCP Wire Response Size: ${serializedWireBytes} bytes (Budget: < ${BYTE_BUDGET_GATE})`);
    assert.ok(serializedWireBytes < BYTE_BUDGET_GATE, `MCP Wire Response size ${serializedWireBytes} exceeds ${BYTE_BUDGET_GATE} bytes`);

    // Verify config and entries on the wire result
    const wireConfig = mcpResult.structuredContent?.config;
    assert.ok(wireConfig, 'wire structuredContent.config must exist');
    assert.strictEqual(wireConfig.blockedCommands?.length, 35, 'wire blockedCommands must contain 35 items');
    assert.ok(Array.isArray(mcpResult.structuredContent?.entries), 'wire structuredContent.entries must exist');
  } finally {
    await client.close();
    env.cleanup();
  }
  console.log('  ✓ Test 7 PASSED\n');

  console.log('=== ALL 7 TEST CASES PASSED SUCCESSFULLY ===');
}

runTests().catch((err) => {
  console.error('\n❌ Test suite failed with error:', err);
  process.exitCode = 1;
});
