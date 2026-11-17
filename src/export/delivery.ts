import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { rename, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { ExportConfig } from './config.js';
import type { ExportWorkspace } from './workspace.js';

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
 * Embedding-host hook: receives a finished archive and owns the file from
 * then on (moves, uploads or deletes it). If it throws, the archive is
 * deleted.
 */
export type ExportDelivery = (file: ExportFile) => Promise<ExportDeliveryResult>;

/**
 * Where finished archives go. Without a target the export tool is refused:
 * stdio uses `fileTarget`, HTTP uses download links (DALUX_PUBLIC_BASE_URL),
 * an embedding host passes its own hook, and DALUX_EXPORT_DELIVERY=file
 * opts HTTP and gateway mode into local files.
 */
export interface ExportTarget {
  kind: 'link' | 'file' | 'host';
  /** Workspace the archives must be written in (the download store's); default: the process workspace of DALUX_EXPORT_DIR. */
  workspace?: ExportWorkspace;
  /** Hand over a finished archive written in `workspace`. */
  deliver(file: ExportFile, workspace: ExportWorkspace): Promise<ExportDeliveryResult>;
}

/** The refusal under a host's policy: the host gives delivery, not the environment. */
export const EXPORT_UNAVAILABLE_HOSTED_MESSAGE =
  'dalux_export_quality_plans is not available on this instance: the embedding host has not given a way to deliver the archive (exportDelivery).';

export const EXPORT_UNAVAILABLE_MESSAGE =
  'dalux_export_quality_plans is not available on this server: no way to deliver the archive is configured. ' +
  'HTTP deployments need DALUX_PUBLIC_BASE_URL (download links), embedding hosts pass exportDelivery, ' +
  'and DALUX_EXPORT_DELIVERY=file keeps archives on the server disk instead.';

/**
 * Keep the archive in the export directory (outside the process
 * subdirectory) under its readable name and return the path. Such files are
 * the user's: they are not deleted automatically and stop counting against
 * the stored-archive limits.
 */
export function fileTarget(): ExportTarget {
  return {
    kind: 'file',
    async deliver(file, workspace) {
      const target = await freeName(workspace.root, file.fileName);
      await rename(file.path, target);
      workspace.forget(file.path);
      return { delivery: 'file', path: target };
    },
  };
}

/** An embedding host's hook; it owns the file once the hook has returned. */
export function hostTarget(hook: ExportDelivery): ExportTarget {
  return {
    kind: 'host',
    async deliver(file, workspace) {
      const result = await hook(file);
      workspace.forget(file.path);
      return result;
    },
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
  config: Pick<ExportConfig, 'ttlMs' | 'oneTime' | 'publicBaseUrl'>;
  workspace: ExportWorkspace;
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
 * constant time. Links expire after the TTL (expired archives are deleted by
 * a sweep and on access) and, with oneTime, after the first complete
 * download. The file served is the one registered with the token; nothing
 * in the request path is used to build a file system path.
 */
export class DownloadStore {
  private readonly entries = new Map<string, StoredDownload>();
  private readonly config: DownloadStoreOptions['config'];
  private readonly workspace: ExportWorkspace;
  private readonly log: (line: string) => void;
  private readonly now: () => number;
  private readonly timer: NodeJS.Timeout;

  constructor(options: DownloadStoreOptions) {
    if (!options.config.publicBaseUrl) {
      throw new Error('DownloadStore requires a public base URL.');
    }
    this.config = options.config;
    this.workspace = options.workspace;
    this.log = options.log ?? (line => console.error(line));
    this.now = options.now ?? Date.now;
    this.timer = setInterval(() => void this.sweep(), Math.min(this.config.ttlMs, 60_000));
    this.timer.unref();
  }

  /** The target that registers archives here and returns their links. */
  get target(): ExportTarget {
    return { kind: 'link', workspace: this.workspace, deliver: file => this.register(file) };
  }

  private async register(file: ExportFile): Promise<ExportDeliveryResult> {
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
  }

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
    const key = entry.tokenHash.toString('hex');
    if (this.config.oneTime) {
      // Taken out before streaming, so a second request gets 404 at once.
      this.entries.delete(key);
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
          // Delete once the file handle is closed (Windows refuses to delete open files).
          if (stream.closed) {
            void this.workspace.remove(entry.path);
          } else {
            stream.once('close', () => void this.workspace.remove(entry.path));
          }
        } else if (entry.expiresAt > this.now()) {
          // An interrupted transfer does not use up the link.
          this.entries.set(key, entry);
        }
      }
    });
  }

  /** Delete expired archives and retry deletions that failed earlier. */
  async sweep(): Promise<void> {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
        await this.workspace.remove(entry.path);
        this.log(`[downloads] ${fingerprint(entry.tokenHash)} expired`);
      }
    }
    await this.workspace.retryDeletes();
  }

  /** Stop the sweep timer and delete every registered archive. */
  async close(): Promise<void> {
    clearInterval(this.timer);
    const entries = [...this.entries.values()];
    this.entries.clear();
    for (const entry of entries) {
      await this.workspace.remove(entry.path);
    }
  }

  private lookup(token: string): StoredDownload | undefined {
    const hash = hashToken(token);
    const entry = this.entries.get(hash.toString('hex'));
    if (!entry || !timingSafeEqual(entry.tokenHash, hash)) {
      return undefined;
    }
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(hash.toString('hex'));
      void this.workspace.remove(entry.path);
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
