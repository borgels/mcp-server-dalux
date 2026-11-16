import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ConfigError,
  type Env,
  readEnvBoolean,
  readEnvInteger,
  readEnvList,
  readEnvPort,
  readEnvString,
} from '../config-env.js';

export const MIN_TOKEN_LENGTH = 32;

export class HttpRequestError extends Error {
  readonly status: number;
  readonly headers: Record<string, string>;
  /** When set, the response body is a JSON-RPC error with this code. */
  readonly jsonRpcCode?: number;

  constructor(
    status: number,
    message: string,
    options: { headers?: Record<string, string>; jsonRpcCode?: number } = {},
  ) {
    super(message);
    this.name = 'HttpRequestError';
    this.status = status;
    this.headers = options.headers ?? {};
    this.jsonRpcCode = options.jsonRpcCode;
  }
}

export interface HttpConfig {
  host: string;
  port: number;
  maxBodyBytes: number;
  httpToken?: string;
  /** Serve /mcp without a token even when that would otherwise be refused. */
  allowUnauthenticated?: boolean;
  allowAnyOrigin?: boolean;
  /** Exact Origin values allowed; empty means any localhost origin. */
  allowedOrigins?: string[];
  /**
   * Host header names allowed on /mcp. Empty means: localhost names when
   * bound to loopback, no Host check otherwise.
   */
  allowedHosts?: string[];
  /** Failed auth attempts per remote address before answering 429. */
  authFailureLimit?: number;
  authFailureWindowMs?: number;
}

const DEFAULT_MAX_BODY_BYTES = 10_485_760;
const DEFAULT_AUTH_FAILURE_LIMIT = 20;
const DEFAULT_AUTH_FAILURE_WINDOW_MS = 60_000;

/**
 * Reads and validates the HTTP transport configuration. Throws ConfigError
 * for invalid values and for insecure combinations (see assertSecureConfig).
 */
export function getHttpConfig(env: Env = process.env): HttpConfig {
  const config: HttpConfig = {
    host: readEnvString('MCP_HTTP_HOST', env) ?? readEnvString('HOST', env) ?? '127.0.0.1',
    port: readEnvPort('PORT', 3000, env),
    maxBodyBytes: readEnvInteger('MCP_MAX_BODY_BYTES', DEFAULT_MAX_BODY_BYTES, {}, env),
    // Not trimmed: the token is compared byte for byte.
    httpToken: env.MCP_HTTP_TOKEN || undefined,
    allowUnauthenticated: readEnvBoolean('MCP_HTTP_ALLOW_UNAUTHENTICATED', false, env),
    allowAnyOrigin: readEnvBoolean('MCP_ALLOW_ANY_ORIGIN', false, env),
    allowedOrigins: readEnvList('MCP_ALLOWED_ORIGINS', env),
    allowedHosts: readEnvList('MCP_ALLOWED_HOSTS', env),
    authFailureLimit: readEnvInteger('MCP_AUTH_FAILURE_LIMIT', DEFAULT_AUTH_FAILURE_LIMIT, {}, env),
    authFailureWindowMs: readEnvInteger('MCP_AUTH_FAILURE_WINDOW_MS', DEFAULT_AUTH_FAILURE_WINDOW_MS, {}, env),
  };
  assertSecureConfig(config);
  return config;
}

/**
 * Refuses configurations that would expose /mcp without authentication:
 * a non-loopback bind address or MCP_ALLOW_ANY_ORIGIN=true without
 * MCP_HTTP_TOKEN, unless MCP_HTTP_ALLOW_UNAUTHENTICATED=true. A configured
 * token must be at least MIN_TOKEN_LENGTH characters.
 */
export function assertSecureConfig(config: HttpConfig): void {
  if (config.httpToken !== undefined && config.httpToken.length < MIN_TOKEN_LENGTH) {
    throw new ConfigError(
      `MCP_HTTP_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters long ` +
        '(for example: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))").',
    );
  }

  if (config.httpToken || config.allowUnauthenticated) {
    return;
  }

  if (!isLoopbackHost(config.host)) {
    throw new ConfigError(
      `Refusing to listen on ${config.host} without MCP_HTTP_TOKEN: anyone who can reach this address ` +
        'could use the Dalux API identity. Set MCP_HTTP_TOKEN, bind to 127.0.0.1, or set ' +
        'MCP_HTTP_ALLOW_UNAUTHENTICATED=true if access is restricted by other means.',
    );
  }

  if (config.allowAnyOrigin) {
    throw new ConfigError(
      'MCP_ALLOW_ANY_ORIGIN=true requires MCP_HTTP_TOKEN: without it any web page opened on this machine ' +
        'could call the server. Set MCP_HTTP_TOKEN or set MCP_HTTP_ALLOW_UNAUTHENTICATED=true.',
    );
  }
}

/** Warnings to log at startup for configurations that are allowed but risky. */
export function configWarnings(config: HttpConfig): string[] {
  if (config.httpToken || !config.allowUnauthenticated) {
    return [];
  }
  if (!isLoopbackHost(config.host) || config.allowAnyOrigin) {
    return [
      `WARNING: MCP_HTTP_ALLOW_UNAUTHENTICATED=true and no MCP_HTTP_TOKEN: /mcp on ${config.host} accepts ` +
        'unauthenticated requests' +
        (config.allowAnyOrigin ? ' from any web origin' : '') +
        '. Anyone who can reach it can act as the Dalux API identity.',
    ];
  }
  return [];
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1');
  if (normalized === 'localhost' || normalized === '::1') {
    return true;
  }
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized)) {
    return true;
  }
  return /^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized);
}

export function assertAuthorized(req: IncomingMessage, config: Pick<HttpConfig, 'httpToken'>): void {
  if (!config.httpToken) {
    return;
  }

  const header = req.headers.authorization ?? '';
  if (!tokensEqual(header, `Bearer ${config.httpToken}`)) {
    throw new HttpRequestError(401, 'Unauthorized', { headers: { 'WWW-Authenticate': 'Bearer' } });
  }
}

/** Constant-time string comparison; both sides are hashed so lengths match. */
export function tokensEqual(actual: string, expected: string): boolean {
  const a = createHash('sha256').update(actual, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

export function assertAllowedOrigin(req: IncomingMessage, config: HttpConfig): void {
  if (!isOriginAllowed(req.headers.origin, config)) {
    throw new HttpRequestError(403, 'Origin not allowed');
  }
}

/**
 * Validates the Host header to guard against DNS rebinding. With
 * MCP_ALLOWED_HOSTS set, the host name (port ignored) must be listed. Without
 * it, a loopback-bound server only accepts localhost names; a server bound
 * elsewhere does not check the Host header.
 */
export function assertAllowedHost(req: IncomingMessage, config: HttpConfig): void {
  let allowed = (config.allowedHosts ?? []).map(item => item.toLowerCase());
  if (!allowed.length) {
    if (!isLoopbackHost(config.host)) {
      return;
    }
    allowed = ['localhost', '127.0.0.1', '[::1]'];
  }

  const hostname = hostnameFromHostHeader(req.headers.host);
  if (!hostname || !allowed.includes(hostname)) {
    throw new HttpRequestError(403, 'Host not allowed');
  }
}

function hostnameFromHostHeader(host: string | undefined): string | undefined {
  if (!host) {
    return undefined;
  }
  try {
    return new URL(`http://${host}`).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

export async function readJsonBody(req: IncomingMessage, maxBodyBytes: number): Promise<unknown> {
  const declaredLength = Number(req.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
    throw new HttpRequestError(413, 'Payload too large');
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > maxBodyBytes) {
      throw new HttpRequestError(413, 'Payload too large');
    }
    chunks.push(buffer);
  }

  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpRequestError(400, 'Parse error: request body is not valid JSON', { jsonRpcCode: -32700 });
  }
}

export function sendJson(
  res: ServerResponse,
  status: number,
  payload: unknown,
  req?: IncomingMessage,
  extraHeaders: Record<string, string> = {},
  config?: HttpConfig,
): void {
  res.writeHead(status, {
    ...(req && config ? corsHeaders(req, config) : {}),
    'Content-Type': 'application/json',
    ...extraHeaders,
  });
  res.end(JSON.stringify(payload));
}

export function corsHeaders(req: IncomingMessage, config: HttpConfig): Record<string, string> {
  const origin = req.headers.origin;
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, mcp-session-id, mcp-protocol-version',
    'Access-Control-Expose-Headers': 'mcp-session-id, WWW-Authenticate',
  };

  if (config.allowAnyOrigin) {
    headers['Access-Control-Allow-Origin'] = '*';
    return headers;
  }

  if (origin && isOriginAllowed(origin, config)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers.Vary = 'Origin';
  }

  return headers;
}

export function isOriginAllowed(
  origin: string | undefined,
  config: Pick<HttpConfig, 'allowAnyOrigin' | 'allowedOrigins'>,
): boolean {
  if (!origin || config.allowAnyOrigin) {
    return true;
  }

  const configuredOrigins = config.allowedOrigins ?? [];
  if (configuredOrigins.length) {
    return configuredOrigins.includes(origin);
  }

  try {
    const url = new URL(origin);
    return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Fixed-window counter of failed authentication attempts per key (remote
 * address). Memory is bounded by `maxEntries`; expired entries are swept and,
 * if still full, the oldest entry is evicted.
 */
export class AuthFailureLimiter {
  private readonly entries = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxEntries = 10_000,
  ) {}

  /** Seconds until the key may retry, or 0 when it is not blocked. */
  retryAfterSeconds(key: string, now = Date.now()): number {
    const entry = this.entries.get(key);
    if (!entry) {
      return 0;
    }
    if (entry.resetAt <= now) {
      this.entries.delete(key);
      return 0;
    }
    return entry.count >= this.limit ? Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) : 0;
  }

  recordFailure(key: string, now = Date.now()): void {
    const entry = this.entries.get(key);
    if (entry && entry.resetAt > now) {
      entry.count += 1;
      return;
    }
    if (entry) {
      this.entries.delete(key);
    }
    if (this.entries.size >= this.maxEntries) {
      this.sweep(now);
      if (this.entries.size >= this.maxEntries) {
        const oldest = this.entries.keys().next().value;
        if (oldest !== undefined) {
          this.entries.delete(oldest);
        }
      }
    }
    this.entries.set(key, { count: 1, resetAt: now + this.windowMs });
  }

  get size(): number {
    return this.entries.size;
  }

  private sweep(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.resetAt <= now) {
        this.entries.delete(key);
      }
    }
  }
}
