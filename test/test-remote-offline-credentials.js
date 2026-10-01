#!/usr/bin/env node
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { readFileSync } from 'node:fs';
import { RemoteChannel } from '../dist/remote-device/remote-channel.js';

process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';
const access = 'test-private-access-token';
const refresh = 'test-private-refresh-token';
const originalSpawn = childProcess.spawnSync;
const calls = [];
childProcess.spawnSync = (command, args, options) => {
  calls.push({ command, args, options });
  return { status: 0, stdout: '', stderr: '' };
};
syncBuiltinESMExports();

try {
  for (const [sessionLost, refreshToken] of [[false, refresh], [true, refresh], [false, undefined]]) {
    const channel = new RemoteChannel();
    channel.sessionLost = sessionLost;
    channel.client = {
      supabaseUrl: 'https://example.invalid', supabaseKey: 'public-anon-key',
      auth: { getSession: async () => ({ data: { session: { access_token: access, refresh_token: refreshToken } } }) },
    };
    await channel.setOffline('device-test');
    const call = calls.at(-1);
    assert.equal(calls.length, sessionLost ? 2 : refreshToken ? 1 : 3);
    assert.equal(call.args.length, 4, 'only script and public connection parameters belong in argv');
    assert(!call.args.some(value => value.includes(access) || value.includes(refresh)), 'tokens must never enter argv');
    assert.equal(call.options.env.SUPABASE_ACCESS_TOKEN, access);
    assert.equal(call.options.env.SUPABASE_REFRESH_TOKEN, sessionLost ? '' : refreshToken || '');
    assert.equal(call.options.timeout, 3000, 'shutdown remains bounded');
  }
  const script = readFileSync(new URL('../src/remote-device/scripts/blocking-offline-update.js', import.meta.url), 'utf8');
  assert.match(script, /const \[deviceId, supabaseUrl, supabaseKey\] = process\.argv\.slice\(2\)/);
  assert.match(script, /const accessToken = process\.env\.SUPABASE_ACCESS_TOKEN/);
  assert.match(script, /const refreshToken = process\.env\.SUPABASE_REFRESH_TOKEN/);
  console.log('PASS: offline tokens stay out of argv; session loss and absent refresh remain supported');
} finally {
  childProcess.spawnSync = originalSpawn;
  syncBuiltinESMExports();
}
