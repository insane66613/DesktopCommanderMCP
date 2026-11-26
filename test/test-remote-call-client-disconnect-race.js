/** Regression: local MCP child can disconnect after readiness resolves. */
import assert from 'node:assert/strict';
import { DesktopCommanderIntegration } from '../dist/remote-device/desktop-commander-integration.js';

process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';
const target = new DesktopCommanderIntegration();

// Deterministically close the readiness-to-dispatch window without spawning.
target.ensureReady = async () => { target.mcpClient = null; };
let failure;
try { await target.callClientTool('get_config', {}); }
catch (error) { failure = error; }
assert.ok(failure instanceof Error, 'disconnected client must fail');
assert.notEqual(failure.name, 'TypeError',
    'lost MCP connection must not leak an implementation TypeError');
assert.match(failure.message, /connection.*lost|disconnected/i,
    'error should identify the lost local MCP connection');

// A healthy client still receives exactly one call, without replay.
let calls = 0;
target.ensureReady = async () => {
    target.mcpClient = { callTool: async ({ name }) => {
        calls++;
        assert.equal(name, 'get_config');
        return { content: [{ type: 'text', text: 'ok' }] };
    } };
};
const result = await target.callClientTool('get_config', {});
assert.equal(calls, 1);
assert.equal(result.content[0].text, 'ok');
console.log('PASS remote MCP dispatch: lost-client race yields classified error; healthy call runs once');
