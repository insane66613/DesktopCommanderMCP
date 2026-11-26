/**
 * RemoteChannel status-write coalescing: duplicate queued writes must not
 * crowd the transport, but health changes and failed writes must still flow.
 * Uses a fake channel and status writer, never the provider or live device.
 */
import assert from 'node:assert/strict';
import { RemoteChannel } from '../dist/remote-device/remote-channel.js';
import { runIfMain } from './helpers/run-if-main.js';

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function fixture({ writer } = {}) {
  const channel = new RemoteChannel();
  const writes = [];
  let executorReady = false;
  channel.deviceId = 'test-device';
  channel.channel = { state: 'joined' };
  channel.presenceTracked = true;
  channel.setLocalExecutorProbe(() => executorReady);
  channel.setOnlineStatus = async (deviceId, status) => {
    writes.push({ deviceId, status });
    await wait(30);
    return writer ? writer({ deviceId, status, attempt: writes.length }) : true;
  };
  return { channel, writes, setReady: (ready) => { executorReady = ready; } };
}

async function main() {
  {
    const { channel, writes } = fixture();
    const values = await Promise.all([
      channel.syncReachabilityStatus(),
      channel.syncReachabilityStatus(),
      channel.syncReachabilityStatus(),
    ]);
    assert.deepEqual(values, [true, true, true]);
    assert.deepEqual(writes.map(x => x.status), ['offline'],
      'same-device same-status requests queued together must share one write');
  }

  {
    const { channel, writes, setReady } = fixture();
    setReady(true);
    const a = channel.syncReachabilityStatus();
    setReady(false);
    const b = channel.syncReachabilityStatus();
    setReady(true);
    const c = channel.syncReachabilityStatus();
    await Promise.all([a, b, c]);
    assert.deepEqual(writes.map(x => x.status), ['online', 'offline', 'online'],
      'a status transition cannot coalesce with an older, identical queued status');
  }

  {
    const { channel, writes } = fixture({ writer: ({ attempt }) => attempt !== 1 });
    const first = await channel.syncReachabilityStatus();
    const retry = await channel.syncReachabilityStatus();
    assert.equal(first, false);
    assert.equal(retry, true);
    assert.equal(writes.length, 2, 'a failed write must remain retryable');
  }

  {
    const { channel, writes } = fixture();
    const first = channel.syncReachabilityStatus();
    channel.deviceId = 'another-device';
    const second = channel.syncReachabilityStatus();
    await Promise.all([first, second]);
    assert.deepEqual(writes.map(x => x.deviceId),
      ['test-device', 'another-device'], 'new device id must not share an earlier write');
  }

  console.log('PASS: duplicate pending remote statuses coalesce; transitions, failures and device ids remain correct');
}
runIfMain(import.meta.url, main);

