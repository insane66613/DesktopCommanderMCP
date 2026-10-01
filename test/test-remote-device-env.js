/**
 * The device (`desktop-commander remote`) starts a local Desktop Commander that
 * runs every tool call. That server must get the device's environment, the
 * same one a Desktop Commander started directly would get: what the user set
 * for the device (a systemd unit's Environment=, a container's env) reaches the
 * tools and the commands they start. Starting it with only the MCP SDK's
 * minimal environment lost, among others, DESKTOP_COMMANDER_DISABLE_TELEMETRY
 * (the device honored it, the server sending the telemetry did not), PATHEXT
 * and ComSpec on Windows, and the container detection variables.
 *
 * Starts the local server through the device's own integration and runs a
 * command that prints a variable set only in the device's environment.
 */
import assert from 'assert';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DesktopCommanderIntegration } from '../dist/remote-device/desktop-commander-integration.js';
import { runIfMain } from './helpers/run-if-main.js';

const MARKER = 'DC_TEST_DEVICE_ENV';

export default async function runTests() {
  process.env[MARKER] = 'set-for-the-device';
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dc-remote-env-'));
  const fixture = path.join(dir, 'print-env.cjs');
  writeFileSync(fixture, `console.log([process.env.${MARKER}, process.env.DC_REMOTE_DEVICE].join('/'));`);
  const integration = new DesktopCommanderIntegration();
  try {
    await integration.initialize();
    const result = await integration.callClientTool('start_process', {
      command: `node "${fixture}"`,
      timeout_ms: 10000,
      shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
    });
    const text = result.content?.[0]?.text ?? '';
    assert(text.includes('set-for-the-device/true'),
      `a command on the device's local server should see the device's ${MARKER} (and DC_REMOTE_DEVICE=true), got:\n${text}`);
    console.log('✓ the local server and its commands get the device\'s environment');
  } finally {
    await integration.shutdown();
    delete process.env[MARKER];
    rmSync(dir, { recursive: true, force: true });
  }
  return true;
}

runIfMain(import.meta.url, runTests);
