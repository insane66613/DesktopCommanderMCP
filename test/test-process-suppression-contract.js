import assert from 'node:assert/strict';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { createTestEnv } from './helpers/test-env.js';
import { runIfMain } from './helpers/run-if-main.js';

async function runTests() {
  const env = createTestEnv();
  Object.assign(process.env, env.env);
  const { configManager } = await import('../dist/config-manager.js');
  await configManager.init();
  const { terminalManager } = await import('../dist/terminal-manager.js');
  const { startProcess } = await import('../dist/tools/improved-process-tools.js');
  const { enrichStructuredContent } = await import('../dist/structured-content.js');
  const { outputSchemaForTool } = await import('../dist/output-schemas.js');
  const validate = new AjvJsonSchemaValidator().getValidator(outputSchemaForTool('start_process'));
  const originalExecute = terminalManager.executeCommand;
  let executed = 0;

  function verifySuppression(result) {
    const receipt = enrichStructuredContent('start_process', result).structuredContent;
    assert.equal(result.isError, undefined, 'expected admission suppression is a normal tool receipt');
    assert.equal(receipt.pid, null);
    assert.equal(receipt.suppressed, true);
    assert.equal(receipt.success, false, 'no process was launched');
    assert.equal(receipt.text, result.content[0].text);
    assert(Number.isInteger(receipt.retryAfterMs) && receipt.retryAfterMs > 0);
    assert.equal(validate(receipt).valid, true, 'suppression must satisfy the advertised MCP output schema');
  }

  try {
    terminalManager.executeCommand = async () => {
      executed += 1;
      return { pid: 987656, output: '', isBlocked: true };
    };
    const args = { command: 'echo contract-duplicate', timeout_ms: 0 };
    await startProcess(args);
    verifySuppression(await startProcess(args));
    assert.equal(executed, 1, 'duplicate suppression must not execute the command again');
    for (let index = 1; index < 12; index += 1) {
      await startProcess({ command: `echo contract-rate-${index}`, timeout_ms: 0 });
    }
    verifySuppression(await startProcess({ command: 'echo contract-over-limit', timeout_ms: 0 }));
    assert.equal(executed, 12, 'rate suppression must not launch an extra process');
    console.log('Duplicate and rate suppression retain schema-valid receipts without launching extra processes.');
  } finally {
    terminalManager.executeCommand = originalExecute;
    env.cleanup();
  }
}

await runIfMain(import.meta.url, runTests);
