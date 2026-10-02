import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createTestEnv, isTestHome } from './helpers/test-env.js';

if (!isTestHome()) {
    const env = createTestEnv();
    try {
        const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
            env: env.env, stdio: 'inherit', timeout: 30_000,
        });
        assert.equal(child.status, 0, child.error?.message);
    } finally { env.cleanup(); }
} else {
    const { assertUrlIsFetchable, fetchUrlValidated } = await import('../dist/utils/urlSafety.js');
    const { readFileFromUrl } = await import('../dist/tools/filesystem.js');
    const { parsePdfToMarkdown } = await import('../dist/tools/pdf/index.js');

    for (const url of [
        'http://169.254.169.254/latest/meta-data/', 'http://127.0.0.1/admin',
        'http://2130706433/', 'http://0x7f000001/', 'http://0.0.0.0/',
        'http://10.0.0.1/', 'http://172.16.5.4/', 'http://192.168.1.1/',
        'http://100.64.0.1/', 'http://[::1]/', 'http://[fd00::1]/',
        'http://[fe90::1]/', 'http://[::ffff:7f00:1]/',
        'file:///etc/passwd', 'ftp://example.com/secret',
    ]) await assert.rejects(() => assertUrlIsFetchable(url), /not allowed|non-public|Invalid URL/);

    await assert.rejects(() => readFileFromUrl('http://127.0.0.1/private'), /non-public/);
    await assert.rejects(() => parsePdfToMarkdown('http://127.0.0.1/private.pdf'), /non-public/);
    await assert.doesNotReject(() => assertUrlIsFetchable('https://8.8.8.8/file'));
    await assert.doesNotReject(() => assertUrlIsFetchable('https://[2001:4860:4860::8888]/file'));

    let requests = 0;
    let discarded = false;
    await assert.rejects(() => fetchUrlValidated('https://8.8.8.8/', undefined, async () => {
        requests++;
        return { status: 302, headers: { get: () => 'http://169.254.169.254/private' },
            body: { destroy: () => { discarded = true; } } };
    }), /non-public/);
    assert.equal(requests, 1, 'redirect target is rejected before another request');
    assert.equal(discarded, true);

    const originalLookup = dns.lookup;
    try {
        dns.lookup = async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }];
        await assert.rejects(() => assertUrlIsFetchable('https://mixed.test/'), /non-public/);
        dns.lookup = async () => [{ address: '127.0.0.1', family: 4 }];
        await assert.rejects(() => assertUrlIsFetchable('http://localhost/'), /non-public/);
        let lookups = 0;
        dns.lookup = async () => { lookups++; return [{ address: '8.8.8.8', family: 4 }]; };
        let agent;
        await fetchUrlValidated('https://rebind.test/', undefined, async (_url, init) => {
            agent = init.agent;
            return { status: 200, headers: { get: () => null } };
        });
        dns.lookup = async () => { throw new Error('a second lookup must not occur'); };
        assert.deepEqual(await new Promise((resolve, reject) => {
            agent.options.lookup('rebind.test', {}, (error, address, family) =>
                error ? reject(error) : resolve({ address, family }));
        }), { address: '8.8.8.8', family: 4 });
        assert.deepEqual(await new Promise((resolve, reject) => {
            agent.options.lookup('rebind.test', { all: true }, (error, addresses) =>
                error ? reject(error) : resolve(addresses));
        }), [{ address: '8.8.8.8', family: 4 }]);
        assert.equal(lookups, 1);
        agent.destroy();

        dns.lookup = async () => new Promise(() => {});
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 25);
        const start = Date.now();
        try {
            await assert.rejects(() => assertUrlIsFetchable('https://slow.test/', controller.signal),
                error => error.name === 'AbortError');
            assert(Date.now() - start < 1000, 'caller deadline bounds DNS waiting');
        } finally { clearTimeout(timer); }
    } finally { dns.lookup = originalLookup; }

    let redirects = 0;
    await assert.rejects(() => fetchUrlValidated('https://8.8.8.8/', undefined, async () => {
        redirects++;
        return { status: 301, headers: { get: () => '/again' }, body: null };
    }), /Too many redirects/);
    assert.equal(redirects, 6, 'at most five redirect hops');
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(() => fetchUrlValidated('https://8.8.8.8/', aborted.signal),
        error => error.name === 'AbortError');
    console.log('PASS: public-address validation, redirect rejection, DNS pinning and bounded DNS abort');
}
