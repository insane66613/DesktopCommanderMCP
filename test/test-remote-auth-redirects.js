#!/usr/bin/env node
/**
 * Upstream security backport (fec69812): device authorization must never follow
 * a redirect, even if the code endpoint or polling endpoint is compromised.
 * No browser, external network, or saved credentials are involved in this test.
 */
import assert from 'node:assert/strict';
import { DeviceAuthenticator } from '../dist/remote-device/device-authenticator.js';

function response(status, body) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json', Date: new Date().toUTCString() },
    });
}

const calls = [];
const auth = new DeviceAuthenticator('https://mcp.desktopcommander.app', {
    fetch: async (url, init) => {
        calls.push({ url: String(url), options: init });
        assert.equal(init.redirect, 'error', 'authorization POST must reject redirects');
        assert.equal(init.method, 'POST');
        if (String(url).endsWith('/device/start')) {
            return response(200, {
                device_code: 'test-device-code',
                user_code: 'TEST-CODE',
                verification_uri: 'https://mcp.desktopcommander.app/verify',
                verification_uri_complete: 'https://mcp.desktopcommander.app/verify?code=TEST-CODE',
                expires_in: 60,
                interval: 5,
            });
        }
        assert.ok(String(url).endsWith('/device/poll'));
        return response(200, { access_token: 'test-access', refresh_token: 'test-refresh', device_id: 'test-id' });
    },
    capture: async () => {},
    open: async () => {},
    monotonicNow: () => 0,
});
auth.sleep = async () => {};
const details = await auth.requestDeviceCode('challenge');
assert.equal(details.device_code, 'test-device-code');
const session = await auth.pollForAuthorization(details, 'test-verifier');
assert.equal(session.access_token, 'test-access');
assert.equal(calls.length, 2);
assert.deepEqual(calls.map(call => new URL(call.url).pathname), ['/device/start', '/device/poll']);
console.log('PASS: authorization code and polling POSTs both explicitly reject redirects');
