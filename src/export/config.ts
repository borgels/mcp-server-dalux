import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ConfigError, type Env, readEnvBoolean, readEnvInteger, readEnvString } from '../config-env.js';
import { isLoopbackHost } from '../transports/http-helpers.js';
import { MAX_ZIP_BYTES, MAX_ZIP_ENTRIES } from './zip.js';

/** Export limits and delivery settings (DALUX_EXPORT_* and DALUX_PUBLIC_BASE_URL). */
export interface ExportConfig {
  /** Directory the archives are written to (each process works in its own subdirectory). */
  dir: string;
  /** Public base URL of this server; enables download links in HTTP mode. */
  publicBaseUrl?: string;
  /** `file`: keep archives on disk and return the path, also in HTTP and gateway mode. */
  delivery?: 'file';
  /** Lifetime of a download link. */
  ttlMs: number;
  /** Delete a download after its first complete transfer. */
  oneTime: boolean;
  /** Cap on one archive (photos are skipped once reached). */
  maxTotalBytes: number;
  /** Cap on the archives this process keeps on disk at once (served or being written). */
  maxStoredBytes: number;
  /** Cap on the number of archives this process keeps on disk at once. */
  maxStoredEntries: number;
  /** Cap on a single downloaded file. */
  maxFileBytes: number;
  /** Bytes reserved for downloads in flight (each reserves maxFileBytes). */
  maxInflightBytes: number;
  /** Cap on the number of downloaded files. */
  maxFiles: number;
  /** Time budget of one export, listing included. */
  timeoutMs: number;
  /** Exports allowed to run at the same time in this process. */
  maxConcurrent: number;
}

const MIB = 1024 * 1024;
export const DEFAULT_EXPORT_TTL_MINUTES = 30;
export const MAX_EXPORT_TTL_MINUTES = 24 * 60;
export const DEFAULT_EXPORT_MAX_TOTAL_BYTES = 2048 * MIB;
export const DEFAULT_EXPORT_MAX_STORED_BYTES = 4096 * MIB;
export const DEFAULT_EXPORT_MAX_STORED_ENTRIES = 20;
export const DEFAULT_EXPORT_MAX_FILE_BYTES = 64 * MIB;
export const MAX_EXPORT_FILE_BYTES = 256 * MIB;
export const DEFAULT_EXPORT_MAX_INFLIGHT_BYTES = 256 * MIB;
export const DEFAULT_EXPORT_MAX_FILES = 20_000;
export const DEFAULT_EXPORT_TIMEOUT_MS = 15 * 60 * 1000;
export const DEFAULT_EXPORT_MAX_CONCURRENT = 2;

/** Default export directory: a fixed folder under the OS temp directory. */
export function defaultExportDir(): string {
  return join(tmpdir(), 'mcp-server-dalux-exports');
}

/**
 * The export limits and work directory: process-wide, from the environment, whatever delivers the archive. Everything
 * about delivery (how, the link's lifetime, one-time links) is left out: that belongs to the target.
 */
export type ExportLimits = Omit<ExportConfig, 'publicBaseUrl' | 'delivery' | 'ttlMs' | 'oneTime'>;

/**
 * Reads and validates the export configuration: the limits plus how the
 * transport delivers archives (DALUX_EXPORT_DELIVERY, DALUX_PUBLIC_BASE_URL,
 * DALUX_EXPORT_TTL_MINUTES, DALUX_EXPORT_ONE_TIME).
 * For the transports and an environment-based gateway. Throws ConfigError
 * for invalid values.
 */
export function getExportConfig(env: Env = process.env): ExportConfig {
  const delivery = readEnvString('DALUX_EXPORT_DELIVERY', env);
  if (delivery !== undefined && delivery !== 'file') {
    throw new ConfigError(`DALUX_EXPORT_DELIVERY must be "file" or unset; got ${JSON.stringify(delivery.slice(0, 40))}.`);
  }
  return {
    ...getExportLimits(env),
    publicBaseUrl: parsePublicBaseUrl(readEnvString('DALUX_PUBLIC_BASE_URL', env)),
    ...(delivery ? { delivery } : {}),
    ttlMs:
      readEnvInteger('DALUX_EXPORT_TTL_MINUTES', DEFAULT_EXPORT_TTL_MINUTES, { min: 1, max: MAX_EXPORT_TTL_MINUTES }, env) *
      60_000,
    oneTime: readEnvBoolean('DALUX_EXPORT_ONE_TIME', false, env),
  };
}

/**
 * Reads and validates the export limits and work directory only. Never reads
 * the delivery settings, so a host's own delivery hook is not affected by
 * them. Throws ConfigError for invalid values.
 */
export function getExportLimits(env: Env = process.env): ExportLimits {
  const dir = readEnvString('DALUX_EXPORT_DIR', env);
  return {
    dir: resolve(dir ?? defaultExportDir()),
    maxTotalBytes: readEnvInteger(
      'DALUX_EXPORT_MAX_TOTAL_BYTES',
      DEFAULT_EXPORT_MAX_TOTAL_BYTES,
      { min: MIB, max: MAX_ZIP_BYTES },
      env,
    ),
    maxStoredBytes: readEnvInteger(
      'DALUX_EXPORT_MAX_STORED_BYTES',
      DEFAULT_EXPORT_MAX_STORED_BYTES,
      { min: MIB, max: 1024 * 1024 * MIB },
      env,
    ),
    maxStoredEntries: readEnvInteger(
      'DALUX_EXPORT_MAX_STORED_ENTRIES',
      DEFAULT_EXPORT_MAX_STORED_ENTRIES,
      { min: 1, max: 10_000 },
      env,
    ),
    maxFileBytes: readEnvInteger(
      'DALUX_EXPORT_MAX_FILE_BYTES',
      DEFAULT_EXPORT_MAX_FILE_BYTES,
      { min: 1024, max: MAX_EXPORT_FILE_BYTES },
      env,
    ),
    maxInflightBytes: readEnvInteger(
      'DALUX_EXPORT_MAX_INFLIGHT_BYTES',
      DEFAULT_EXPORT_MAX_INFLIGHT_BYTES,
      { min: MIB, max: 1024 * MIB },
      env,
    ),
    maxFiles: readEnvInteger('DALUX_EXPORT_MAX_FILES', DEFAULT_EXPORT_MAX_FILES, { min: 1, max: MAX_ZIP_ENTRIES - 16 }, env),
    timeoutMs: readEnvInteger('DALUX_EXPORT_TIMEOUT_MS', DEFAULT_EXPORT_TIMEOUT_MS, { min: 1000, max: 6 * 60 * 60 * 1000 }, env),
    maxConcurrent: readEnvInteger('DALUX_EXPORT_MAX_CONCURRENT', DEFAULT_EXPORT_MAX_CONCURRENT, { min: 1, max: 16 }, env),
  };
}

/**
 * DALUX_PUBLIC_BASE_URL: the origin clients reach this server at, e.g.
 * `https://mcp.example.com`. https unless the host is loopback; no path
 * (downloads are served at /downloads/ on the server root), credentials,
 * query or fragment.
 */
function parsePublicBaseUrl(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError('DALUX_PUBLIC_BASE_URL must be an absolute http(s) URL.');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) {
    throw new ConfigError('DALUX_PUBLIC_BASE_URL must use https (http is only accepted for loopback hosts).');
  }
  if (url.username || url.password || url.search || url.hash || value.includes('?') || value.includes('#')) {
    throw new ConfigError('DALUX_PUBLIC_BASE_URL must not contain credentials, a query string or a fragment.');
  }
  if (url.pathname !== '/') {
    throw new ConfigError(
      'DALUX_PUBLIC_BASE_URL must be an origin without a path (e.g. https://mcp.example.com): downloads are served at /downloads/ on the server root.',
    );
  }
  return url.origin;
}
