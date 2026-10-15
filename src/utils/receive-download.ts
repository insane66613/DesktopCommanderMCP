import fs from 'node:fs/promises';
import path from 'node:path';
import https from 'node:https';
import type { IncomingMessage } from 'node:http';
import type { LookupFunction } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { validatePath } from '../tools/filesystem.js';
import { assertUrlIsFetchable } from './urlSafety.js';

const MAX_BYTES = 100 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 45_000;
class DownloadError extends Error {}

async function checkDestination(filePath: string, overwrite: boolean): Promise<void> {
  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new DownloadError('Destination must be a regular file, not a symbolic link or directory');
    if (!overwrite) throw new DownloadError('Destination already exists; explicit overwrite is required');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function openDownload(rawUrl: string, signal: AbortSignal): Promise<IncomingMessage> {
  let url = new URL(rawUrl);
  for (let hop = 0; ; hop++) {
    if (url.protocol !== 'https:' || (url.port && url.port !== '443') || url.username || url.password) {
      throw new DownloadError('File download requires HTTPS on port 443 without URL credentials');
    }
    const addresses = await assertUrlIsFetchable(url.toString(), signal);
    const lookup: LookupFunction = (_hostname, options, callback) => {
      if (typeof options === 'object' && options.all) {
        callback(null, addresses.map(address => ({ ...address })));
      } else {
        const family = typeof options === 'object' ? options.family : options;
        const selected = addresses.find(address => address.family === family) ?? addresses[0];
        callback(null, selected.address, selected.family);
      }
    };
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const request = https.get(url, {
        agent: false, lookup, signal, headers: { 'Accept-Encoding': 'identity' },
      }, resolve);
      request.once('error', reject);
    });
    if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
      const location = response.headers.location;
      response.destroy();
      if (!location || hop >= 3) throw new DownloadError('File download redirect limit exceeded or redirect missing');
      url = new URL(location, url);
      continue;
    }
    if (response.statusCode !== 200) {
      response.destroy();
      throw new DownloadError(`File download returned HTTP ${response.statusCode ?? 0}`);
    }
    const encoding = response.headers['content-encoding'];
    if (encoding && encoding.toLowerCase().trim() !== 'identity') {
      response.destroy();
      throw new DownloadError('File download must use identity content encoding');
    }
    const length = response.headers['content-length'];
    if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) {
      response.destroy();
      throw new DownloadError('File download exceeds the 100 MiB size limit');
    }
    return response;
  }
}

/** Stream an uploaded file URL into an atomic, policy-checked local destination. */
export async function downloadReceivedFile(options: {
  url: string;
  path: string;
  expectedSha256?: string;
  overwrite?: boolean;
  signal?: AbortSignal;
}): Promise<{ byteCount: number; sha256: string }> {
  const signal = AbortSignal.any([AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), ...(options.signal ? [options.signal] : [])]);
  let temporaryPath: string | undefined;
  let file: Awaited<ReturnType<typeof fs.open>> | undefined;
  let response: IncomingMessage | undefined;
  try {
    if (!path.isAbsolute(options.path)) throw new DownloadError('File destination must be an absolute path');
    if (options.expectedSha256 !== undefined && !/^[a-f0-9]{64}$/i.test(options.expectedSha256)) {
      throw new DownloadError('Expected SHA-256 must contain exactly 64 hexadecimal characters');
    }
    const overwrite = options.overwrite === true;
    await checkDestination(options.path, overwrite);
    const destination = await validatePath(options.path);
    await checkDestination(destination, overwrite);
    const parent = await fs.realpath(path.dirname(destination));
    signal.throwIfAborted();
    temporaryPath = path.join(parent, `.receive-${randomBytes(16).toString('hex')}.part`);
    file = await fs.open(temporaryPath, 'wx', 0o600);
    response = await openDownload(options.url, signal);
    const hash = createHash('sha256');
    let byteCount = 0;
    for await (const chunk of response) {
      signal.throwIfAborted();
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteCount += bytes.length;
      if (byteCount > MAX_BYTES) throw new DownloadError('File download exceeds the 100 MiB size limit');
      hash.update(bytes);
      await file.writeFile(bytes);
    }
    const sha256 = hash.digest('hex');
    if (options.expectedSha256 && sha256 !== options.expectedSha256.toLowerCase()) {
      throw new DownloadError('File download SHA-256 integrity check failed');
    }
    await file.close();
    file = undefined;
    if (await validatePath(options.path) !== destination || await fs.realpath(path.dirname(destination)) !== parent) {
      throw new DownloadError('File destination changed during download');
    }
    await checkDestination(options.path, overwrite);
    await checkDestination(destination, overwrite);
    signal.throwIfAborted();
    if (overwrite) await fs.rename(temporaryPath, destination);
    else await fs.link(temporaryPath, destination); // Atomic no-clobber commit; never replace an existing file.
    return { byteCount, sha256 };
  } catch (error) {
    if (signal.aborted) throw new DownloadError('File download cancelled or timed out');
    if (error instanceof DownloadError) throw error;
    // Network errors can contain signed URLs; never expose their messages or causes.
    throw new DownloadError('File download failed or destination is not allowed or accessible');
  } finally {
    response?.destroy();
    await file?.close().catch(() => {});
    if (temporaryPath) await fs.unlink(temporaryPath).catch(() => {});
  }
}
