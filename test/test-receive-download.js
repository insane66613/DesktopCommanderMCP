import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createTestEnv, isTestHome } from './helpers/test-env.js';

if (!isTestHome()) {
  const isolated = createTestEnv();
  try {
    const child = spawnSync(process.execPath, [import.meta.filename], {
      env: isolated.env, stdio: 'inherit', timeout: 60_000,
    });
    assert.equal(child.status, 0, child.error?.message);
  } finally { isolated.cleanup(); }
} else {
  const { downloadReceivedFile } = await import('../dist/utils/receive-download.js');
  const { configManager } = await import('../dist/config-manager.js');
  const directory = await fs.mkdtemp(path.join(os.homedir(), 'receive-fixture-'));
  const payload = Buffer.from([0, 255, 128, 13, 10, 1, 0, 254, 42]);
  const digest = createHash('sha256').update(payload).digest('hex');
  const largeChunk = Buffer.alloc(1024 * 1024, 127);
  let requestHook = async () => {};
  const fixture = http.createServer(async (req, res) => {
    try {
      await requestHook(req.url);
      const url = new URL(req.url, 'http://fixture.test');
      if (url.pathname === '/redirect-private') {
        res.writeHead(302, { Location: 'https://127.0.0.1/private?signature=private-token' }).end();
      } else if (url.pathname === '/redirects') {
        res.writeHead(302, { Location: '/redirects' }).end();
      } else if (url.pathname === '/redirect') {
        res.writeHead(302, { Location: '/binary' }).end();
      } else if (url.pathname === '/large-header') {
        res.writeHead(200, { 'Content-Length': 100 * 1024 * 1024 + 1 }).end();
      } else if (url.pathname === '/large-stream') {
        res.writeHead(200);
        for (let i = 0; i < 101 && !res.destroyed; i++) {
          if (!res.write(largeChunk)) await new Promise(resolve => {
            const done = () => { res.off('drain', done); res.off('close', done); resolve(); };
            res.once('drain', done);
            res.once('close', done);
          });
        }
        res.end();
      } else if (url.pathname === '/partial') {
        res.writeHead(200, { 'Content-Length': 100 });
        res.write(payload);
        setTimeout(() => res.destroy(), 10);
      } else if (url.pathname === '/slow') {
        res.writeHead(200);
        res.write(payload);
        // Kept open until the downloader's total deadline/caller cancellation closes it.
      } else if (url.pathname === '/encoded') {
        res.writeHead(200, { 'Content-Encoding': 'gzip' }).end(payload);
      } else if (url.pathname === '/empty') {
        res.writeHead(200, { 'Content-Length': 0 }).end();
      } else {
        res.writeHead(200, { 'Content-Length': payload.length }).end(payload);
      }
    } catch { res.destroy(); }
  });
  fixture.listen(0, '127.0.0.1');
  await once(fixture, 'listening');
  const originalGet = https.get;
  const originalLookup = dns.lookup;
  const originalTimeout = AbortSignal.timeout;
  const lookedUp = [];
  const connections = [];
  dns.lookup = async (host, options) => {
    lookedUp.push(host);
    assert.equal(options.all, true);
    if (host === 'throw.test') throw new Error('Network error https://throw.test/?signature=private-token');
    if (host === 'mixed.test') return [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }];
    if (host === 'private.test') return [{ address: '192.168.1.3', family: 4 }];
    return [{ address: '8.8.8.8', family: 4 }];
  };
  // Test-only transport injection: validate/pin a public fixture hostname, but carry
  // its bytes through a real local HTTP server without exposing production TLS bypasses.
  https.get = (url, options, callback) => {
    let pinned;
    options.lookup(url.hostname, { all: false, family: 4 }, (error, address) => {
      assert.ifError(error);
      pinned = address;
    });
    assert.equal(pinned, '8.8.8.8');
    let all;
    options.lookup(url.hostname, { all: true }, (error, addresses) => { assert.ifError(error); all = addresses; });
    assert.deepEqual(all, [{ address: '8.8.8.8', family: 4 }]);
    assert.equal(options.headers['Accept-Encoding'], 'identity');
    connections.push(url.pathname);
    return http.get({ hostname: '127.0.0.1', port: fixture.address().port,
      path: url.pathname + url.search, headers: options.headers, signal: options.signal }, callback);
  };
  await configManager.setValue('allowedDirectories', [directory]);
  const target = (name) => path.join(directory, name);
  const input = (name, route = '/binary') => ({ url: `https://fixture.test${route}?signature=private-token`, path: target(name) });
  const noParts = async () => assert.deepEqual((await fs.readdir(directory)).filter(name => name.endsWith('.part')), []);
  const rejectClean = async (options, pattern) => {
    await assert.rejects(downloadReceivedFile(options), error => {
      assert(!error.message.includes('private-token'));
      assert(!error.message.includes('https://'));
      return !pattern || pattern.test(error.message);
    });
    await noParts();
  };
  try {
    const startLookups = lookedUp.length;
    const result = await downloadReceivedFile({ ...input('binary.bin'), expectedSha256: digest.toUpperCase() });
    assert.deepEqual(result, { byteCount: payload.length, sha256: digest });
    assert.deepEqual(await fs.readFile(target('binary.bin')), payload);
    assert.equal(lookedUp.length, startLookups + 1, 'connect lookup stays pinned rather than resolving again');
    assert(!JSON.stringify(result).includes('private-token'));
    await noParts();
    const emptyHash = createHash('sha256').digest('hex');
    assert.deepEqual(await downloadReceivedFile({ ...input('empty.bin', '/empty'), expectedSha256: emptyHash }),
      { byteCount: 0, sha256: emptyHash });
    assert.equal((await fs.stat(target('empty.bin'))).size, 0);
    await noParts();

    await rejectClean(input('binary.bin'), /already exists/);
    assert.deepEqual(await fs.readFile(target('binary.bin')), payload);
    await fs.writeFile(target('existing.bin'), 'original');
    await rejectClean({ ...input('existing.bin'), overwrite: true, expectedSha256: '0'.repeat(64) }, /integrity/);
    assert.equal(await fs.readFile(target('existing.bin'), 'utf8'), 'original');
    await downloadReceivedFile({ ...input('existing.bin'), overwrite: true, expectedSha256: digest });
    assert.deepEqual(await fs.readFile(target('existing.bin')), payload);
    await noParts();

    for (const route of ['/large-header', '/large-stream', '/partial', '/encoded']) {
      await rejectClean(input('rejected.bin', route));
      await assert.rejects(fs.stat(target('rejected.bin')), { code: 'ENOENT' });
    }
    await rejectClean({ ...input('existing.bin', '/partial'), overwrite: true });
    assert.deepEqual(await fs.readFile(target('existing.bin')), payload, 'partial transfer never replaces an existing file');
    const cancellation = new AbortController();
    setTimeout(() => cancellation.abort(), 40);
    await rejectClean({ ...input('cancelled.bin', '/slow'), signal: cancellation.signal }, /cancelled|timed out/);
    AbortSignal.timeout = (milliseconds) => {
      assert.equal(milliseconds, 45_000, 'fixed total deadline leaves bridge cleanup headroom');
      return originalTimeout(40);
    };
    await rejectClean(input('timeout.bin', '/slow'), /timed out/);
    AbortSignal.timeout = originalTimeout;

    const beforeRedirect = connections.length;
    await rejectClean(input('redirect.bin', '/redirect-private'));
    assert.equal(connections.length, beforeRedirect + 1, 'private redirect is rejected before connection');
    const beforeLoop = connections.length;
    await rejectClean(input('redirect.bin', '/redirects'), /redirect/);
    assert.equal(connections.length, beforeLoop + 4, 'at most three redirects are followed');
    await downloadReceivedFile(input('redirect.bin', '/redirect'));
    assert.deepEqual(await fs.readFile(target('redirect.bin')), payload);

    for (const url of ['http://fixture.test/file', 'https://fixture.test:444/file', 'https://user:secret@fixture.test/file',
      'https://127.0.0.1/file', 'https://[::1]/file', 'https://169.254.169.254/file', 'https://224.0.0.1/file',
      'https://0.0.0.0/file', 'https://[fc00::1]/file', 'https://[fe80::1]/file', 'https://[ff02::1]/file',
      'https://[::ffff:127.0.0.1]/file', 'https://mixed.test/file', 'https://private.test/file', 'https://throw.test/file']) {
      const before = connections.length;
      await rejectClean({ url, path: target('unsafe.bin') });
      assert.equal(connections.length, before, 'unsafe endpoint never reaches the transport');
    }
    await rejectClean({ ...input('relative.bin'), path: 'relative.bin' }, /absolute/);
    await rejectClean({ ...input('restricted.bin'), path: path.join(os.homedir(), 'outside.bin') });
    await rejectClean({ ...input('hash.bin'), expectedSha256: 'not-a-digest' }, /SHA-256/);

    requestHook = async (route) => {
      if (route.startsWith('/race')) await fs.writeFile(target('race.bin'), 'raced');
    };
    await rejectClean(input('race.bin', '/race'), /already exists/);
    assert.equal(await fs.readFile(target('race.bin'), 'utf8'), 'raced');
    requestHook = async (route) => {
      if (route.startsWith('/policy-change')) await configManager.setValue('allowedDirectories', [path.join(directory, 'other')]);
    };
    await rejectClean({ ...input('policy.bin', '/policy-change') });
    await assert.rejects(fs.stat(target('policy.bin')), { code: 'ENOENT' });
    await configManager.setValue('allowedDirectories', [directory]);
    requestHook = async () => {};
    try {
      await fs.symlink(target('existing.bin'), target('link.bin'), 'file');
      await rejectClean({ ...input('link.bin'), overwrite: true }, /symbolic link/);
      assert.deepEqual(await fs.readFile(target('existing.bin')), payload);
      requestHook = async route => {
        if (route.startsWith('/late-link')) await fs.symlink(target('existing.bin'), target('late-link.bin'), 'file');
      };
      await rejectClean({ ...input('late-link.bin', '/late-link'), overwrite: true });
      assert.deepEqual(await fs.readFile(target('existing.bin')), payload, 'late destination symlink never redirects the write');
    } catch (error) {
      if (!['EPERM', 'EACCES'].includes(error.code)) throw error;
      console.log('SKIP: host denies creation of test file symlinks');
    }
    console.log('PASS: binary/hash, streamed limits, integrity/overwrite, cleanup, cancellation/deadline, redirects, SSRF/DNS pinning, path policy');
  } finally {
    https.get = originalGet;
    dns.lookup = originalLookup;
    AbortSignal.timeout = originalTimeout;
    fixture.closeAllConnections();
    await new Promise(resolve => fixture.close(resolve));
  }
}
