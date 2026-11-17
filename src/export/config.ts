import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ConfigError, type Env, readEnvBoolean, readEnvInteger, readEnvString } from '../config-env.js';
import { isLoopbackHost } from '../transports/http-helpers.js';
import { MAX_ZIP_BYTES, MAX_ZIP_ENTRIES } from './zip.js';

/** Export limits and delivery settings (DALUX_EXPORT_* and DALUX_PUBLIC_BASE_URL). */
export interface ExportConfig {
  /** Directory the archives are written to. */
  dir: string;
  /** Public base URL of this server; enables download links in HTTP mode. */
  publicBaseUrl?: string;
  /** Lifetime of a download link. */
  ttlMs: number;
  /** Delete a download after its first complete transfer. */
  oneTime: boolean;
  /** Cap on the archive size (photos are skipped once reached). */
  maxTotalBytes: number;
  /** Cap on a single downloaded file. */
  maxFileBytes: number;
  /** Cap on the number of downloaded files. */
  maxFiles: number;
  /** Time budget of one export; files not downloaded by then are listed as failures. */
  timeoutMs: number;
  /** Exports allowed to run at the same time in this process. */
  maxConcurrent: number;
}

export const DEFAULT_EXPORT_TTL_MINUTES = 30;
export const DEFAULT_EXPORT_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
export const DEFAULT_EXPORT_MAX_FILE_BYTES = 100 * 1024 * 1024;
export const DEFAULT_EXPORT_MAX_FILES = 20_000;
export const DEFAULT_EXPORT_TIMEOUT_MS = 15 * 60 * 1000;
export const DEFAULT_EXPORT_MAX_CONCURRENT = 2;

/** Default export directory: a fixed folder under the OS temp directory. */
export function defaultExportDir(): string {
  return join(tmpdir(), 'mcp-server-dalux-exports');
}

/** Reads and validates the export configuration. Throws ConfigError for invalid values. */
export function getExportConfig(env: Env = process.env): ExportConfig {
  const dir = readEnvString('DALUX_EXPORT_DIR', env);
  return {
    dir: resolve(dir ?? defaultExportDir()),
    publicBaseUrl: parsePublicBaseUrl(readEnvString('DALUX_PUBLIC_BASE_URL', env)),
    ttlMs: readEnvInteger('DALUX_EXPORT_TTL_MINUTES', DEFAULT_EXPORT_TTL_MINUTES, { min: 1, max: 24 * 60 }, env) * 60_000,
    oneTime: readEnvBoolean('DALUX_EXPORT_ONE_TIME', false, env),
    maxTotalBytes: readEnvInteger(
      'DALUX_EXPORT_MAX_TOTAL_BYTES',
      DEFAULT_EXPORT_MAX_TOTAL_BYTES,
      { min: 1024 * 1024, max: MAX_ZIP_BYTES },
      env,
    ),
    maxFileBytes: readEnvInteger(
      'DALUX_EXPORT_MAX_FILE_BYTES',
      DEFAULT_EXPORT_MAX_FILE_BYTES,
      { min: 1024, max: 1024 * 1024 * 1024 },
      env,
    ),
    maxFiles: readEnvInteger('DALUX_EXPORT_MAX_FILES', DEFAULT_EXPORT_MAX_FILES, { min: 1, max: MAX_ZIP_ENTRIES - 16 }, env),
    timeoutMs: readEnvInteger('DALUX_EXPORT_TIMEOUT_MS', DEFAULT_EXPORT_TIMEOUT_MS, { min: 1000, max: 6 * 60 * 60 * 1000 }, env),
    maxConcurrent: readEnvInteger('DALUX_EXPORT_MAX_CONCURRENT', DEFAULT_EXPORT_MAX_CONCURRENT, { min: 1, max: 16 }, env),
  };
}

/**
 * DALUX_PUBLIC_BASE_URL: the URL clients reach this server at, e.g.
 * `https://mcp.example.com`. https unless the host is loopback; no
 * credentials, query or fragment. A trailing slash is dropped.
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
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}
