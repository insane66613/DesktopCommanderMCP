#!/usr/bin/env node
/** Prove installed MCP SDK v1 timeout and cancellation using its real Client. */
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

function createTransport({ respondToTools = false } = {}) {
    const outbound = [];
    const transport = {
        onmessage: undefined,
        onclose: undefined,
        onerror: undefined,
        async start() {},
        async close() {},
        async send(message) {
            outbound.push(message);
            if (message.method === 'initialize') {
                queueMicrotask(() => transport.onmessage?.({
                    jsonrpc: '2.0',
                    id: message.id,
                    result: {
                        protocolVersion: '2025-06-18',
                        capabilities: { tools: {} },
                        serverInfo: { name: 'timeout-stand-in', version: '1.0' },
                    },
                }));
            }
            if (message.method === 'tools/call' && respondToTools) {
                setTimeout(() => transport.onmessage?.({
                    jsonrpc: '2.0',
                    id: message.id,
                    result: { content: [{ type: 'text', text: 'completed' }] },
                }), 8);
            }
        },
    };
    return { transport, outbound };
}

const fake = createTransport();
const client = new Client({ name: 'timeout-test', version: '1.0' }, { capabilities: {} });
await client.connect(fake.transport);
const t0 = Date.now();
await assert.rejects(
    () => client.callTool({ name: 'never-replies', arguments: {} }, undefined, { timeout: 35 }),
    /timed out/i,
    'real SDK must enforce a 35ms configured tool-call deadline',
);
const elapsed = Date.now() - t0;
assert.ok(elapsed >= 25 && elapsed < 1500, `SDK timeout duration: ${elapsed}ms`);
const req = fake.outbound.find(m => m.method === 'tools/call');
const cancellation = fake.outbound.find(m => m.method === 'notifications/cancelled');
assert.ok(req, 'real SDK dispatched the tool call through transport');
assert.equal(cancellation?.params?.requestId, req.id,
    'real SDK should send JSON-RPC cancellation on its request timeout');
await client.close();

const fast = createTransport({ respondToTools: true });
const success = new Client({ name: 'timeout-test-2', version: '1.0' }, { capabilities: {} });
await success.connect(fast.transport);
const result = await success.callTool(
    { name: 'fast-reply', arguments: {} }, undefined, { timeout: 150 },
);
assert.equal(result.content?.[0]?.text, 'completed');
assert.equal(fast.outbound.some(m => m.method === 'notifications/cancelled'), false,
    'successful tool response must not be cancelled');
await success.close();
console.log('PASS real MCP SDK enforces third-argument timeout and emits cancellation notification');
console.log('NOTE cancellation notification alone does not prove server-side work was terminated');
