#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const fixture = fileURLToPath(new URL('./fixtures/remote-startup-log-privacy.mjs', import.meta.url));
const endpoint = 'https://private-endpoint.desktopcommander.app';
for (const debug of ['false', 'true']) {
    const child = spawnSync(process.execPath, [fixture], {
        encoding: 'utf8',
        timeout: 10000,
        env: {
            ...process.env,
            DEBUG_MODE: debug,
            DESKTOP_COMMANDER_DISABLE_TELEMETRY: '1',
        },
    });
    assert.equal(child.status, 1, `controlled startup must exit 1 (DEBUG_MODE=${debug}): ${child.error ?? child.stderr}`);
    assert.match(child.stdout, /Connecting to Remote MCP/);
    assert.match(child.stderr, /intentional startup stop/);
    assert.equal(child.stdout.includes(endpoint), debug === 'true', `endpoint exposure DEBUG_MODE=${debug}`);
    assert.equal(child.stderr.includes(endpoint), false, 'endpoint must not appear in stderr');
}
console.log('PASS: remote endpoint omitted from normal startup logs and gated to explicit DEBUG_MODE');
