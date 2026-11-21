#!/usr/bin/env node
/** Regression for upstream 9a620b63: match the hosted 30m + 30s server window. */
import assert from 'node:assert/strict';
import { DesktopCommanderIntegration } from '../dist/remote-device/desktop-commander-integration.js';

const calls = [];
const integration = new DesktopCommanderIntegration();
// A local fake MCP child is sufficient: this test is about forwarding the SDK
// timeout, not waiting half an hour or connecting to any remote service.
integration.ensureReady = async () => {};
integration.mcpClient = {
    callTool: async (...parameters) => {
        calls.push(parameters);
        return { content: [{ type: 'text', text: 'result' }] };
    }
};
const reply = await integration.callClientTool('start_process', { command: 'echo test' }, { trace: 'test' });
assert.equal(reply.content[0].text, 'result');
assert.equal(calls.length, 1, 'exactly one MCP tool call');
assert.equal(calls[0][0].name, 'start_process');
assert.deepEqual(calls[0][0].arguments, { command: 'echo test' });
assert.deepEqual(calls[0][0]._meta, { remote: true, trace: 'test' });
assert.equal(calls[0][2]?.timeout, 30 * 60_000 + 30_000,
    'SDK deadline must match the hosted 30m execution plus 30s sweep window');
console.log('PASS remote call forwards the upstream 30m30s SDK timeout');
