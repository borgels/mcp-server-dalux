import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import type { ExportConfig } from './config.js';

/** A finished export archive on local disk. */
export interface ExportFile {
  /** Absolute path of the archive. */
  path: string;
  /** Suggested download name (`[A-Za-z0-9._-]`, ends in `.zip`). */
  fileName: string;
  sizeBytes: number;
  contentType: 'application/zip';
}

/** How the archive reached the caller; merged into the tool result. */
export interface ExportDeliveryResult {
  /** `link`: download URL; `file`: local path; `host`: handled by an embedding host. */
  delivery: 'link' | 'file' | 'host';
  url?: string;
  path?: string;
  expiresAt?: string;
  oneTime?: boolean;
  [key: string]: unknown;
}

/**
 * Hands a finished archive to the caller. Owns the file from then on: it
 * moves, serves or deletes it.
 */
export type ExportDelivery = (file: ExportFile) => Promise<ExportDeliveryResult>;

/** Internal file names of archives (in-progress or served); nothing else in the directory is touched. */
const INTERNAL_NAME = /^(?:\.partial-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.zip$/;

export function isInternalExportName(name: string): boolean {
  return INTERNAL_NAME.test(name);
}

export async function ensureExportDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
}

/**
 * Default delivery (stdio, or HTTP without DALUX_PUBLIC_BASE_URL): keep the
 * archive in the export directory under its readable name and return the
 * path. Such files are not deleted automatically.
 */
export function fileDelivery(): ExportDelivery {
  return async file => {
    const dir = dirname(file.path);
    const target = await freeName(dir, file.fileName);
    await rename(file.path, target);
    return { delivery: 'file', path: target };
  };
}

async function freeName(dir: string, fileName: string): Promise<string> {
  const stem = fileName.replace(/\.zip$/, '');
  for (let n = 1; n < 1000; n += 1) {
    const candidate = join(dir, n === 1 ? fileName : `${stem}-${n}.zip`);
    try {
      await stat(candidate);
    } catch {
      return candidate;
    }
  }
  throw new Error('Could not find a free export file name.');
}

interface StoredDownload {
  tokenHash: Buffer;
  path: string;
  fileName: string;
  sizeBytes: number;
  expiresAt: number;
}

export interface DownloadStoreOptions {
  config: Pick<ExportConfig, 'dir' | 'ttlMs' | 'oneTime' | 'publicBaseUrl'>;
  log?: (line: string) => void;
  /** Injectable clock for tests. */
  now?: () => number;
}

/** Matches the whole download path; anything else under /downloads/ is a 404. */
const DOWNLOAD_PATH = /^\/downloads\/([A-Za-z0-9_-]{43})\/([A-Za-z0-9._-]{1,200})$/;
export const DOWNLOADS_PREFIX = '/downloads/';

/**
 * Serves finished exports at `GET /downloads/<token>/<fileName>` without the
 * MCP bearer token: the URL is the capability. The token is 32 random bytes
 * (base64url); only its SHA-256 is kept, and lookups compare hashes in
 * constant time. Links expire after the TTL (expired files are deleted by a
 * sweep and on access) and, with oneTime, after the first complete
 * download. The file served is the one registered with the token; nothing
 * in the request path is used to build a file system path.
 */
export class DownloadStore {
  private readonly entries = new Map<string, StoredDownload>();
  private readonly config: DownloadStoreOptions['config'];
  private readonly log: (line: string) => void;
  private readonly now: () => number;
  private readonly timer: NodeJS.Timeout;

  constructor(options: DownloadStoreOptions) {
    if (!options.config.publicBaseUrl) {
      throw new Error('DownloadStore requires a public base URL.');
    }
    this.config = options.config;
    this.log = options.log ?? (line => console.error(line));
    this.now = options.now ?? Date.now;
    this.timer = setInterval(() => void this.sweep(), Math.min(this.config.ttlMs, 60_000));
    this.timer.unref();
  }

  /**
   * Remove archives left in the export directory by an earlier process
   * (their tokens were only held in memory). Only internal names are
   * touched.
   */
  async removeLeftovers(): Promise<void> {
    await ensureExportDir(this.config.dir);
    for (const name of await readdir(this.config.dir)) {
      if (isInternalExportName(name)) {
        await rm(join(this.config.dir, name), { force: true }).catch(() => undefined);
      }
    }
  }

  /** The delivery that registers archives here and returns their links. */
  readonly delivery: ExportDelivery = async file => {
    const token = randomBytes(32).toString('base64url');
    const tokenHash = hashToken(token);
    const expiresAt = this.now() + this.config.ttlMs;
    this.entries.set(tokenHash.toString('hex'), {
      tokenHash,
      path: file.path,
      fileName: file.fileName,
      sizeBytes: file.sizeBytes,
      expiresAt,
    });
    this.log(`[downloads] registered ${fingerprint(tokenHash)} (${file.sizeBytes} bytes)`);
    return {
      delivery: 'link',
      url: `${this.config.publicBaseUrl}${DOWNLOADS_PREFIX}${token}/${encodeURIComponent(file.fileName)}`,
      expiresAt: new Date(expiresAt).toISOString(),
      oneTime: this.config.oneTime,
    };
  };

  get size(): number {
    return this.entries.size;
  }

  /** Handle GET/HEAD /downloads/...; the caller routes only paths under DOWNLOADS_PREFIX here. */
  async handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendStatus(res, 405, { Allow: 'GET, HEAD' });
      return;
    }
    const match = DOWNLOAD_PATH.exec(path);
    const entry = match ? this.lookup(match[1]!) : undefined;
    if (!match || !entry || entry.fileName !== match[2]) {
      sendStatus(res, 404);
      return;
    }

    const headers = {
      'Content-Type': 'application/zip',
      'Content-Length': String(entry.sizeBytes),
      'Content-Disposition': `attachment; filename="${entry.fileName}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    };
    if (req.method === 'HEAD') {
      res.writeHead(200, headers);
      res.end();
      return;
    }

    const id = fingerprint(entry.tokenHash);
    if (this.config.oneTime) {
      // Taken out before streaming, so a second request gets 404 at once.
      this.entries.delete(entry.tokenHash.toString('hex'));
    }
    const stream = createReadStream(entry.path);
    stream.once('error', () => {
      this.log(`[downloads] ${id} could not be read`);
      if (!res.headersSent) {
        sendStatus(res, 404);
      } else {
        res.destroy();
      }
    });
    stream.once('open', () => {
      res.writeHead(200, headers);
      stream.pipe(res);
    });
    res.once('close', () => {
      stream.destroy();
      const complete = res.writableFinished;
      this.log(`[downloads] ${id} ${complete ? 'served' : 'aborted'}`);
      if (this.config.oneTime) {
        if (complete) {
          void rm(entry.path, { force: true }).catch(() => undefined);
        } else {
          // An interrupted transfer does not use up the link.
          this.entries.set(entry.tokenHash.toString('hex'), entry);
        }
      }
    });
  }

  /** Delete expired archives. */
  async sweep(): Promise<void> {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
        await rm(entry.path, { force: true }).catch(() => undefined);
        this.log(`[downloads] ${fingerprint(entry.tokenHash)} expired`);
      }
    }
  }

  /** Stop the sweep timer and delete every registered archive. */
  async close(): Promise<void> {
    clearInterval(this.timer);
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(entries.map(entry => rm(entry.path, { force: true }).catch(() => undefined)));
  }

  private lookup(token: string): StoredDownload | undefined {
    const hash = hashToken(token);
    const entry = this.entries.get(hash.toString('hex'));
    if (!entry || !timingSafeEqual(entry.tokenHash, hash)) {
      return undefined;
    }
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(hash.toString('hex'));
      void rm(entry.path, { force: true }).catch(() => undefined);
      return undefined;
    }
    return entry;
  }
}

function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

/** Short, non-reversible id of a download for logs (never the token). */
function fingerprint(tokenHash: Buffer): string {
  return `#${tokenHash.toString('hex').slice(0, 8)}`;
}

function sendStatus(res: ServerResponse, status: number, headers: Record<string, string> = {}): void {
  const body = JSON.stringify({ error: status === 404 ? 'Not found' : 'Method not allowed' });
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

/** Replace a download token in a request path for logging. */
export function redactDownloadPath(url: string): string {
  return url.startsWith(DOWNLOADS_PREFIX) ? `${DOWNLOADS_PREFIX}[redacted]` : url;
}
