import dns from 'dns/promises';
import http from 'http';
import https from 'https';
import type { LookupFunction } from 'net';
import fetch from 'cross-fetch';
import ipaddr from 'ipaddr.js';

const MAX_REDIRECTS = 5;
const URL_TIMEOUT_MS = 30_000;

export interface ValidatedAddress {
    address: string;
    family: 4 | 6;
}

function isPublicAddress(ip: string): boolean {
    try {
        let address = ipaddr.parse(ip);
        if (address.kind() === 'ipv6' && (address as ipaddr.IPv6).isIPv4MappedAddress()) {
            address = (address as ipaddr.IPv6).toIPv4Address();
        }
        return address.range() === 'unicast';
    } catch {
        return false;
    }
}

/** Bound DNS waiting too; the OS lookup itself cannot be cancelled. */
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
        const onAbort = () => reject(new DOMException('URL fetch aborted', 'AbortError'));
        signal.addEventListener('abort', onAbort, { once: true });
        operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
        if (signal.aborted) onAbort();
    });
}

export async function assertUrlIsFetchable(
    rawUrl: string,
    signal: AbortSignal = AbortSignal.timeout(URL_TIMEOUT_MS),
): Promise<ValidatedAddress[]> {
    if (signal.aborted) throw new DOMException('URL fetch aborted', 'AbortError');
    let parsed: URL;
    try { parsed = new URL(rawUrl); }
    catch { throw new Error('Invalid URL'); }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('URL protocol not allowed: only http and https can be read');
    }
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
    if (ipaddr.isValid(hostname)) {
        if (!isPublicAddress(hostname)) throw new Error('Refusing to fetch a non-public address');
        return [{ address: hostname, family: ipaddr.parse(hostname).kind() === 'ipv6' ? 6 : 4 }];
    }
    const resolved = await abortable(dns.lookup(hostname, { all: true }), signal);
    if (!resolved.length || resolved.some(({ address, family }) =>
        !isPublicAddress(address) || (family !== 4 && family !== 6))) {
        throw new Error('Refusing to fetch a host that resolves to a non-public address');
    }
    return resolved as ValidatedAddress[];
}

function pinnedAgent(url: URL, addresses: ValidatedAddress[]): http.Agent {
    const lookup: LookupFunction = (_hostname, options, callback) => {
        if (typeof options === 'object' && options.all) {
            callback(null, addresses.map(address => ({ ...address })));
            return;
        }
        const family = typeof options === 'object' ? options.family : options;
        const selected = addresses.find(address => address.family === family) ?? addresses[0];
        callback(null, selected.address, selected.family);
    };
    return url.protocol === 'https:' ? new https.Agent({ lookup }) : new http.Agent({ lookup });
}

export async function fetchUrlValidated(
    rawUrl: string,
    signal: AbortSignal = AbortSignal.timeout(URL_TIMEOUT_MS),
    fetchImpl: typeof fetch = fetch,
): Promise<{ response: Awaited<ReturnType<typeof fetch>>; finalUrl: string }> {
    let currentUrl = rawUrl;
    for (let hop = 0; ; hop++) {
        const addresses = await assertUrlIsFetchable(currentUrl, signal);
        const agent = pinnedAgent(new URL(currentUrl), addresses);
        const response = await fetchImpl(currentUrl, { signal, redirect: 'manual', agent } as RequestInit);
        const location = response.headers.get('location');
        if (![301, 302, 303, 307, 308].includes(response.status) || !location) {
            return { response, finalUrl: currentUrl };
        }
        const body = response.body as { destroy?: () => void; cancel?: () => Promise<void> } | null;
        if (body?.destroy) body.destroy();
        else if (body?.cancel) void body.cancel().catch(() => {});
        agent.destroy();
        if (hop >= MAX_REDIRECTS) throw new Error('Too many redirects while fetching URL');
        currentUrl = new URL(location, currentUrl).toString();
    }
}
