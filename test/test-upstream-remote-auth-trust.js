#!/usr/bin/env node
/**
 * Selective upstream backport of fec69812 + 6cb7f9d4 for the older fork.
 * Credentials must be tied to the validated remote MCP and Supabase origins.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
    DEFAULT_REMOTE_SERVER_URL, SUPABASE1_ORIGIN, SUPABASE2_ORIGIN,
    savedSessionMatchesContext,
    validateRemoteServerUrl, validateRemoteAuthContext,
} from '../dist/remote-device/remote-utils.js';
import { MCPDevice } from '../dist/remote-device/device.js';

process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';
const valid = validateRemoteAuthContext(DEFAULT_REMOTE_SERVER_URL, SUPABASE1_ORIGIN);
assert.equal(valid.serverOrigin, DEFAULT_REMOTE_SERVER_URL);
assert.equal(valid.supabaseUrl, SUPABASE1_ORIGIN);

for (const invalid of [
    'http://192.168.1.5:80', 'https://other.example',
    'https://mcp.desktopcommander.app.attacker.example',
    'https://user:password@mcp.desktopcommander.app',
    'https://mcp.desktopcommander.app/a',
    'https://mcp.desktopcommander.app/?redirect=1',
    'https://mcp.desktopcommander.app/#token',
]) {
    assert.throws(() => validateRemoteServerUrl(invalid), /Unsafe/, invalid);
}
assert.equal(validateRemoteServerUrl('http://127.0.0.1:19050').origin, 'http://127.0.0.1:19050');

for (const invalid of [
    'https://attacker.supabase.co', 'https://supabase.co.attacker.example',
    'https://user:secret@olvbkozcufcbptfogatw.supabase.co',
    SUPABASE1_ORIGIN + '/subpath',
    SUPABASE2_ORIGIN + '?token=1',
    'https://example.supabase.co', // upstream third origin is an unverified placeholder
    SUPABASE1_ORIGIN + '.attacker.example',
    'http://127.0.0.1:19051',
]) {
    assert.throws(
        () => validateRemoteAuthContext(DEFAULT_REMOTE_SERVER_URL, invalid),
        /Unsafe/, invalid,
    );
}
assert.equal(
    validateRemoteAuthContext('http://127.0.0.1:19050', 'http://127.0.0.1:19050').supabaseUrl,
    'http://127.0.0.1:19050',
    'the existing same-origin loopback stand-in must remain supported',
);
assert.throws(
    () => validateRemoteAuthContext('http://127.0.0.1:19050', 'http://127.0.0.1:19051'),
    /Unsafe/,
    'loopback Supabase must not move to a different port',
);

assert.equal(savedSessionMatchesContext(undefined, valid), true);
const otherProject = validateRemoteAuthContext(DEFAULT_REMOTE_SERVER_URL, SUPABASE2_ORIGIN);
assert.equal(savedSessionMatchesContext(undefined, otherProject), false);
assert.equal(savedSessionMatchesContext(valid, otherProject), false);
assert.equal(savedSessionMatchesContext(otherProject, otherProject), true);
assert.equal(savedSessionMatchesContext({ ...valid, serverOrigin: 'https://different.example' }, valid), false);

const originalFetch = globalThis.fetch;
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-upstream-remote-trust-'));
const device = new MCPDevice();
device.configPath = path.join(root, 'device.json');
const token = { access_token: 'test-access-token', refresh_token: 'test-refresh-token' };
const save = async (value) => fs.writeFile(device.configPath, JSON.stringify(value), 'utf8');
try {
    globalThis.fetch = async (url, options) => {
        assert.equal(options.redirect, 'error', 'backend config fetch must not follow redirects');
        assert.ok(options.signal, 'backend config fetch must have a deadline');
        assert.equal(new URL(url).origin, DEFAULT_REMOTE_SERVER_URL);
        return new Response(JSON.stringify({
            supabaseUrl: 'https://attacker.supabase.co',
            supabasePublishableKey: 'public-key',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    await assert.rejects(() => device.fetchSupabaseConfig(), /Unsafe Supabase URL/);
    assert.equal(device.trustedAuthContext, null);

    globalThis.fetch = async () => new Response(JSON.stringify({
        supabaseUrl: SUPABASE2_ORIGIN,
        supabasePublishableKey: 'public-key',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const info = await device.fetchSupabaseConfig();
    assert.equal(info.supabaseUrl, SUPABASE2_ORIGIN);

    await save({ deviceId: 'old-device', session: token }); // Legacy unbound supabase1
    assert.equal(await device.loadPersistedConfig(), null);
    assert.equal(device.deviceId, undefined, 'rejected credentials must not carry old device ID');

    await save({ deviceId: 'other-device', authContext: valid, session: token });
    assert.equal(await device.loadPersistedConfig(), null);
    assert.equal(device.deviceId, undefined);

    await save({ deviceId: 'matching-device', authContext: otherProject, session: token });
    assert.deepEqual(await device.loadPersistedConfig(), token);
    assert.equal(device.deviceId, 'matching-device');

    device.remoteChannel.getSession = async () => ({ data: { session: token } });
    await device.savePersistedConfig();
    const persisted = JSON.parse(await fs.readFile(device.configPath, 'utf8'));
    assert.deepEqual(persisted.authContext, otherProject);
    assert.equal(persisted.session.refresh_token, token.refresh_token);
    console.log('PASS: backend URL allowlist, local stand-in, redirect refusal and bounded fetch');
    console.log('PASS: saved sessions are rejected when backend or Supabase project differs');
    console.log('PASS: matching bound session and subsequent writes retain auth context');
} finally {
    globalThis.fetch = originalFetch;
    await fs.rm(root, { recursive: true, force: true });
}
