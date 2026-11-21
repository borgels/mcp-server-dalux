import { isIP } from 'node:net';
import { DaluxHttpError, describeUrl, nestedFailuresAsStatus, parseRetryAfterMs, requestIdFrom, SecretRedactor, UpstreamRedirectError } from '../errors.js';
import { USER_AGENT } from '../version.js';

export interface DaluxClientOptions {
  /** API key. When omitted, read from DALUX_API_KEY in `credentialEnv`. */
  apiKey?: string;
  /** API base URL. When omitted, read from DALUX_BASE_URL in `credentialEnv`, else the default Field host. */
  baseUrl?: string;
  /**
   * Where omitted credentials (apiKey, baseUrl) are read from. Defaults to
   * process.env for the standalone server. The gateway passes `{}`, so an
   * embedded instance only ever uses the credentials it was given.
   */
  credentialEnv?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  /** Per-attempt timeout covering headers and body (default 30 s, env DALUX_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Maximum number of concurrent requests to Dalux from this client (default 4, env DALUX_MAX_CONCURRENCY). */
  maxConcurrency?: number;
  /** Total attempts for idempotent GETs on 429/502/503/504 and transient network errors (default 3). */
  maxAttempts?: number;
  /** Base delay of the exponential backoff between retries (default 500 ms). */
  retryBaseDelayMs?: number;
  /**
   * Total time one call may spend waiting between retries (default 10 s). A
   * Retry-After that does not fit in the remaining budget is not waited for;
   * the response is returned to the caller instead.
   */
  retryBudgetMs?: number;
  /** Server ceiling for file downloads (default 25 MB, env DALUX_MAX_DOWNLOAD_BYTES). */
  maxDownloadBytes?: number;
  /** Allow a base URL outside *.dalux.com (env DALUX_ALLOW_CUSTOM_BASE_URL=true). */
  allowCustomBaseUrl?: boolean;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export type QueryValue = string | number | boolean | null | undefined;

type HttpMethod = 'GET' | 'POST' | 'PATCH';

interface AttemptOptions {
  /** Total attempts for a GET (default: the client's maxAttempts). */
  attempts?: number;
  /** Per-attempt timeout (default: the client's timeoutMs). */
  timeoutMs?: number;
}

/** Default server ceiling for downloads. */
export const DEFAULT_DOWNLOAD_CEILING = 25 * 1024 * 1024;
/** Upper bound for the download ceiling and for the maxBytes tool parameter. */
export const MAX_DOWNLOAD_BYTES_PARAM = 100 * 1024 * 1024;

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
/** Error bodies are only read up to this size. */
const MAX_ERROR_BODY_BYTES = 64 * 1024;
/** Largest delay accepted by Node timers. */
const MAX_TIMER_MS = 2_147_483_647;
/** Error codes (on `error.cause`) of connection-level failures worth retrying. */
const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

/**
 * Client for the Dalux Build API (covers both the Field and Box modules).
 * Auth is a single X-API-KEY header issued per "API identity"; keys expire
 * and are scoped by the user groups assigned to the identity per project.
 *
 * Redirects are never followed automatically, so the key cannot be forwarded
 * to another origin. Idempotent GETs are retried with backoff on throttling,
 * gateway errors and transient network failures; POST/PATCH are never retried.
 *
 * Each client owns a SecretRedactor holding its own key and key header;
 * errors raised by the client, and the audit records and tool results of
 * calls made through it, are redacted with it.
 */
export class DaluxClient {
  readonly redactor: SecretRedactor;
  private readonly apiKey?: string;
  readonly baseUrl: string;
  /** Server ceiling for a single file download, in bytes. */
  readonly maxDownloadBytes: number;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryBudgetMs: number;
  private readonly semaphore: Semaphore;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: DaluxClientOptions = {}) {
    const credentialEnv = options.credentialEnv ?? process.env;
    this.apiKey = options.apiKey ?? credentialEnv.DALUX_API_KEY;
    this.redactor = new SecretRedactor().addHeader('X-API-KEY').addSecret(this.apiKey);
    this.baseUrl = trimTrailingSlash(
      options.baseUrl ?? credentialEnv.DALUX_BASE_URL ?? 'https://field.dalux.com/service/api',
    );
    assertSafeBaseUrl(
      this.baseUrl,
      options.allowCustomBaseUrl ?? process.env.DALUX_ALLOW_CUSTOM_BASE_URL === 'true',
    );
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = intOption('timeoutMs', options.timeoutMs, 'DALUX_TIMEOUT_MS', 30_000, 1, MAX_TIMER_MS);
    this.maxDownloadBytes = intOption(
      'maxDownloadBytes',
      options.maxDownloadBytes,
      'DALUX_MAX_DOWNLOAD_BYTES',
      DEFAULT_DOWNLOAD_CEILING,
      1,
      MAX_DOWNLOAD_BYTES_PARAM,
    );
    this.semaphore = new Semaphore(
      intOption('maxConcurrency', options.maxConcurrency, 'DALUX_MAX_CONCURRENCY', 4, 1, 64),
    );
    this.maxAttempts = intOption('maxAttempts', options.maxAttempts, undefined, 3, 1, 10);
    this.retryBaseDelayMs = intOption('retryBaseDelayMs', options.retryBaseDelayMs, undefined, 500, 0, 60_000);
    this.retryBudgetMs = intOption('retryBudgetMs', options.retryBudgetMs, undefined, 10_000, 0, 600_000);
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  }

  async get<T>(path: string, query?: Record<string, QueryValue>): Promise<T> {
    return this.request<T>('GET', this.buildUrl(path, query));
  }

  /**
   * GET with a single attempt (no retries) and a timeout of at most
   * `timeoutMs`. For best-effort lookups that must not delay the real call.
   */
  async getOnce<T>(path: string, timeoutMs: number): Promise<T> {
    return this.request<T>('GET', this.buildUrl(path), undefined, undefined, {
      attempts: 1,
      timeoutMs: Math.min(timeoutMs, this.timeoutMs),
    });
  }

  /**
   * Follow an absolute link (self/nextPage) returned by the API. The link must
   * stay on the API origin, under the configured base path and — when
   * `resourcePath` is given — on that same resource (any API version prefix).
   */
  async getAbsolute<T>(href: string, resourcePath?: string): Promise<T> {
    this.assertFollowableLink(href, resourcePath);
    return this.request<T>('GET', href);
  }

  async post<T>(path: string, body?: unknown, query?: Record<string, QueryValue>): Promise<T> {
    return this.request<T>('POST', this.buildUrl(path, query), body);
  }

  async postBinary<T>(path: string, body: Uint8Array, extraHeaders?: Record<string, string>): Promise<T> {
    return this.request<T>('POST', this.buildUrl(path), body, extraHeaders);
  }

  async patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PATCH', this.buildUrl(path), body);
  }

  /**
   * Fetch binary content (file downloads). The byte cap is enforced while
   * streaming: the transfer is aborted as soon as it is exceeded. A single
   * https redirect is followed; the API key is only sent along when the
   * target is on the API origin.
   */
  async getBinary(path: string, maxBytes: number): Promise<{ bytes: Uint8Array; contentType: string }> {
    return this.download(this.buildUrl(path), maxBytes);
  }

  /**
   * Fetch binary content from a download link returned by the API (for
   * example `fileDownload` of a form attachment). These links point at the
   * API origin but outside the API base path, and their path carries an
   * access token, so the link must stay on the API origin and errors never
   * repeat it: they name only the HTTP status or the kind of failure.
   */
  async getBinaryLink(href: string, maxBytes: number): Promise<{ bytes: Uint8Array; contentType: string }> {
    const url = this.assertDownloadLink(href);
    try {
      return await this.download(url, maxBytes);
    } catch (error) {
      throw downloadLinkError(error);
    }
  }

  /** Validates a download link: http(s), API origin, no credentials, dot segments or encoded separators. */
  private assertDownloadLink(href: string): string {
    const base = new URL(this.baseUrl);
    let target: URL;
    try {
      target = new URL(href);
    } catch {
      throw new DownloadLinkError('Refusing to follow an invalid download link.');
    }
    if (target.origin !== base.origin || target.username || target.password) {
      throw new DownloadLinkError('Refusing to follow a download link outside the API origin.');
    }
    const rawPath = href.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '').split(/[?#]/, 1)[0] ?? '';
    if (
      rawPath.includes('\\') ||
      /%2e|%2f|%5c/i.test(rawPath) ||
      rawPath.split('/').some(segment => segment === '.' || segment === '..')
    ) {
      throw new DownloadLinkError('Refusing to follow a download link containing dot segments or encoded separators.');
    }
    return target.toString();
  }

  private async download(url: string, maxBytes: number): Promise<{ bytes: Uint8Array; contentType: string }> {
    const headers = this.headers();
    const base = new URL(this.baseUrl);

    return this.execute('GET', url, { method: 'GET', headers }, async (first, signal) => {
      let response = first;
      let responseUrl = url;

      if (isRedirect(response.status)) {
        let target: URL;
        try {
          target = redirectTarget(response, url);
        } finally {
          await discardBody(response);
        }
        const sameOrigin = target.origin === base.origin;
        if (target.protocol !== 'https:') {
          throw refusedRedirect('Refusing to follow a download redirect that is not https.', response);
        }
        // A redirect off the API origin must not point into a local or private
        // network (unless the API itself is a local mock).
        if (!sameOrigin && isPrivateHost(target.hostname) && !isLocalHost(base.hostname)) {
          throw refusedRedirect('Refusing to follow a download redirect to a local or private address.', response);
        }
        // The complete next URL, checked before any request: one that carries the key (in any form, or a piece of
        // it) is never fetched.
        if (this.redactor.matches(target.toString()) || this.redactor.matches(decodeURIComponentSafe(target.toString()))) {
          throw refusedRedirect('Refusing to follow a download redirect that carries the API key.', response);
        }
        const hopHeaders: Record<string, string> = sameOrigin
          ? headers
          : { Accept: headers.Accept ?? '*/*', 'User-Agent': USER_AGENT };
        responseUrl = target.toString();
        try {
          response = await this.fetchImpl(responseUrl, {
            method: 'GET',
            headers: hopHeaders,
            redirect: 'manual',
            signal,
          });
        } catch (error) {
          throw this.transportError('GET', url, error);
        }
        if (isRedirect(response.status)) {
          await discardBody(response);
          throw refusedRedirect(`Dalux download redirected more than once (HTTP ${response.status}); not following.`, response);
        }
      }

      if (!response.ok) {
        const payload = await readErrorBody(response);
        throw new DaluxHttpError({
          status: response.status,
          url: describeUrl(responseUrl),
          payload,
          retryAfter: response.headers.get('retry-after') ?? undefined,
          requestId: requestIdFrom(response.headers),
        });
      }

      const declared = Number(response.headers.get('content-length') ?? 0);
      if (Number.isFinite(declared) && declared > maxBytes) {
        await discardBody(response);
        throw new Error(tooLargeMessage(`${declared} bytes`, maxBytes));
      }

      const { bytes, exceeded } = await bodyRead(() => readUpTo(response, maxBytes));
      if (exceeded) {
        throw new Error(tooLargeMessage(`more than ${maxBytes} bytes`, maxBytes));
      }
      return {
        bytes,
        contentType: response.headers.get('content-type') ?? 'application/octet-stream',
      };
    });
  }

  buildUrl(path: string, query?: Record<string, QueryValue>): string {
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    const url = new URL(`${this.baseUrl}${normalizedPath}`);

    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null || value === '') {
        continue;
      }
      url.searchParams.set(key, String(value));
    }

    return url.toString();
  }

  assertFollowableLink(href: string, resourcePath?: string): void {
    // A link is Dalux's text: one that carries the API key (in any form, or a piece of it) is never fetched.
    if (this.redactor.matches(href) || this.redactor.matches(decodeURIComponentSafe(href))) {
      throw new Error('Refusing to follow a link that carries the API key.');
    }
    const base = new URL(this.baseUrl);
    let target: URL;
    try {
      target = new URL(href);
    } catch {
      // The link is Dalux's text: never quoted.
      throw new Error('Refusing to follow an invalid link.');
    }
    if (target.origin !== base.origin) {
      throw new Error('Refusing to follow a link outside the API address.');
    }

    // Dot segments are normalised away by the URL parser, so inspect the raw
    // path as well as the parsed one.
    const rawPath = href.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '').split(/[?#]/, 1)[0] ?? '';
    if (
      rawPath.includes('\\') ||
      /%2e|%2f|%5c/i.test(rawPath) ||
      rawPath.split('/').some(segment => segment === '.' || segment === '..')
    ) {
      throw new Error('Refusing to follow link containing dot segments or encoded separators.');
    }

    const basePath = trimTrailingSlash(base.pathname);
    if (!target.pathname.startsWith(`${basePath}/`)) {
      throw new Error('Refusing to follow link outside the API base path.');
    }

    if (resourcePath !== undefined) {
      const actual = resourceKey(target.pathname.slice(basePath.length));
      const expected = resourceKey(resourcePath.split('?', 1)[0] ?? resourcePath);
      if (actual !== expected) {
        throw new Error('Refusing to follow link that points at a different resource than the requested list.');
      }
    }
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    if (!this.apiKey) {
      throw new Error('Missing DALUX_API_KEY. Set it in the MCP server environment.');
    }
    return {
      Accept: 'application/json, application/octet-stream',
      'User-Agent': USER_AGENT,
      'X-API-KEY': this.apiKey,
      ...extra,
    };
  }

  private async request<T>(
    method: HttpMethod,
    url: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
    attemptOptions?: AttemptOptions,
  ): Promise<T> {
    const headers = this.headers();
    const init: RequestInit = { method, headers };

    if (body !== undefined) {
      if (body instanceof Uint8Array) {
        headers['Content-Type'] = 'application/octet-stream';
        init.body = body as unknown as RequestInit['body'];
      } else {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
    }
    Object.assign(headers, extraHeaders);

    return this.execute(method, url, init, async response => {
      if (isRedirect(response.status)) {
        await discardBody(response);
        throw new UpstreamRedirectError(this.redactor.redact(redirectRefusedMessage(response, method, url)), {
          status: response.status,
          requestId: requestIdFrom(response.headers),
        });
      }

      if (!response.ok) {
        const payload = await readErrorBody(response);
        throw new DaluxHttpError({
          status: response.status,
          url: describeUrl(url),
          payload,
          retryAfter: response.headers.get('retry-after') ?? undefined,
          requestId: requestIdFrom(response.headers),
        });
      }

      // A failure reported inside a successful body keeps only its status and our own text.
      return nestedFailuresAsStatus(await readResponseBody(response)) as T;
    }, attemptOptions);
  }

  /**
   * Run one logical request: limit concurrency, apply the timeout, and retry
   * idempotent GETs on retryable statuses and transient network errors
   * within the retry budget. `handle` runs while the concurrency slot is
   * held, so body reads count against it.
   */
  private async execute<R>(
    method: HttpMethod,
    url: string,
    init: RequestInit,
    handle: (response: Response, signal: AbortSignal) => Promise<R>,
    attemptOptions: AttemptOptions = {},
  ): Promise<R> {
    const maxAttempts = method === 'GET' ? (attemptOptions.attempts ?? this.maxAttempts) : 1;
    const timeoutMs = attemptOptions.timeoutMs ?? this.timeoutMs;
    let slept = 0;

    for (let attempt = 1; ; attempt += 1) {
      const canRetry = attempt < maxAttempts;
      let delayMs: number | undefined;
      const release = await this.semaphore.acquire();
      try {
        const signal = AbortSignal.timeout(timeoutMs);
        let response: Response | undefined;
        try {
          response = await this.fetchImpl(url, { ...init, redirect: 'manual', signal });
        } catch (error) {
          delayMs = canRetry && isTransientNetworkError(error) ? this.retryDelay(attempt, undefined, slept) : undefined;
          if (delayMs === undefined) {
            throw this.transportError(method, url, error);
          }
        }

        if (response) {
          if (canRetry && RETRYABLE_STATUS.has(response.status)) {
            delayMs = this.retryDelay(attempt, parseRetryAfterMs(response.headers.get('retry-after')), slept);
          }
          if (delayMs === undefined) {
            try {
              return await handle(response, signal);
            } catch (error) {
              // Failures while reading the body surface as raw fetch errors.
              if (isTimeoutError(error)) {
                throw this.transportError(method, url, error);
              }
              if (!isTransientNetworkError(error)) {
                throw error;
              }
              delayMs = canRetry ? this.retryDelay(attempt, undefined, slept) : undefined;
              if (delayMs === undefined) {
                throw this.transportError(method, url, error);
              }
            }
          }
          await discardBody(response);
        }
      } finally {
        release();
      }
      // Wait outside the concurrency slot.
      const wait = delayMs ?? 0;
      slept += wait;
      await this.sleep(wait);
    }
  }

  /**
   * Delay before the next attempt: exponential backoff with jitter, or the
   * server's Retry-After if longer. Undefined when the wait would exceed the
   * remaining retry budget (the caller then gives up).
   */
  private retryDelay(attempt: number, retryAfterMs: number | undefined, slept: number): number | undefined {
    const backoff = this.retryBaseDelayMs * 2 ** (attempt - 1) + Math.random() * this.retryBaseDelayMs;
    const delay = Math.max(backoff, retryAfterMs ?? 0);
    return slept + delay > this.retryBudgetMs ? undefined : delay;
  }

  // Our own words with the method only: the address is configuration and is not quoted.
  private transportError(method: HttpMethod, _url: string, error: unknown): Error {
    if (isTimeoutError(error)) {
      return new Error(this.redactor.redact(`Dalux request timed out after ${this.timeoutMs} ms (${method}).`));
    }
    // Only a system error code (ECONNREFUSED, ENOTFOUND, ...) from the cause, never its message.
    const code = error instanceof Error ? (error.cause as { code?: unknown } | undefined)?.code : undefined;
    const shown = typeof code === 'string' && SHOWN_NETWORK_CODES.has(code) ? ` (${code})` : '';
    return new Error(this.redactor.redact(`Network error calling Dalux (${method})${shown}.`), { cause: error });
  }
}

/**
 * Read an integer environment variable. Unset or empty returns the fallback;
 * anything else that is not an integer within bounds throws, so a typo never
 * silently disables a limit.
 */
export function readIntegerEnv(
  name: string,
  fallback: number,
  bounds: { min?: number; max?: number } = {},
): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const value = Number(raw);
  if (!/^-?\d+$/.test(raw)) {
    // The value is not quoted: a configuration value is never echoed, not even shortened.
    throw new Error(`${name} must be an integer ${rangeText(bounds)}.`);
  }
  return checkInt(name, value, bounds);
}

function checkInt(name: string, value: number, bounds: { min?: number; max?: number }): number {
  const min = bounds.min ?? Number.MIN_SAFE_INTEGER;
  const max = bounds.max ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer ${rangeText(bounds)}.`);
  }
  return value;
}

function rangeText(bounds: { min?: number; max?: number }): string {
  const min = bounds.min ?? Number.MIN_SAFE_INTEGER;
  return bounds.max === undefined ? `>= ${min}` : `between ${min} and ${bounds.max}`;
}

/** Option value if given, else the environment variable (if any), else the default; always validated. */
function intOption(
  optionName: string,
  value: number | undefined,
  envName: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value !== undefined) {
    return checkInt(optionName, value, { min, max });
  }
  return envName ? readIntegerEnv(envName, fallback, { min, max }) : fallback;
}

class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.active >= this.limit) {
      await new Promise<void>(resolve => this.waiters.push(resolve));
    } else {
      this.active += 1;
    }
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const next = this.waiters.shift();
      if (next) {
        next(); // hand the slot over directly
      } else {
        this.active -= 1;
      }
    };
  }
}

/**
 * Error of a download through a link returned by the API. The message never
 * contains the link (its path carries an access token); `status` is the
 * HTTP status when Dalux answered with an error.
 */
export class DownloadLinkError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'DownloadLinkError';
    this.status = status;
  }
}

function downloadLinkError(error: unknown): DownloadLinkError {
  if (error instanceof DownloadLinkError) {
    return error;
  }
  if (error instanceof DaluxHttpError) {
    return new DownloadLinkError(`Download failed with HTTP ${error.status}.`, error.status);
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith('Download aborted: file is')) {
    // The size message holds no URL.
    return new DownloadLinkError(message.split('. Raise maxBytes', 1)[0] + '.');
  }
  if (/timed out/i.test(message)) {
    return new DownloadLinkError('Download timed out.');
  }
  if (/redirect/i.test(message)) {
    return new DownloadLinkError('Download refused: unexpected redirect.');
  }
  return new DownloadLinkError(message.startsWith('Network error') ? 'Download failed: network error.' : 'Download failed.');
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

/** A redirect of Dalux's that is not followed: our own message, with the status and request id of the answer. */
function refusedRedirect(message: string, response: Response): UpstreamRedirectError {
  return new UpstreamRedirectError(message, { status: response.status, requestId: requestIdFrom(response.headers) });
}

function redirectTarget(response: Response, requestUrl: string): URL {
  const location = response.headers.get('location');
  if (!location) {
    throw refusedRedirect(`Dalux download responded with HTTP ${response.status} without a Location header.`, response);
  }
  try {
    return new URL(location, requestUrl);
  } catch {
    throw refusedRedirect('Dalux download redirected to an invalid URL; not following.', response);
  }
}

/** The redirect's Location is Dalux's text and is never quoted; only the status and our own request. */
function redirectRefusedMessage(response: Response, method: HttpMethod, _url: string): string {
  return (
    `Dalux API responded with a redirect (HTTP ${response.status}) for ${method}; ` +
    'redirects are not followed. Check that DALUX_BASE_URL is the API address shown in Dalux.'
  );
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

/** fetch reports connection failures as TypeError with a coded cause; only those are retried. */
function isTransientNetworkError(error: unknown): boolean {
  if (!(error instanceof TypeError)) {
    return false;
  }
  return causeCodes(error.cause).some(code => TRANSIENT_NETWORK_CODES.has(code));
}

function causeCodes(cause: unknown, depth = 0): string[] {
  if (typeof cause !== 'object' || cause === null || depth > 3) {
    return [];
  }
  const codes: string[] = [];
  const { code, errors, cause: inner } = cause as { code?: unknown; errors?: unknown; cause?: unknown };
  if (typeof code === 'string') {
    codes.push(code);
  }
  if (Array.isArray(errors)) {
    for (const entry of errors) {
      codes.push(...causeCodes(entry, depth + 1));
    }
  }
  codes.push(...causeCodes(inner, depth + 1));
  return codes;
}

function tooLargeMessage(size: string, maxBytes: number): string {
  return `Download aborted: file is ${size}, which exceeds the ${maxBytes} byte limit. Raise maxBytes (up to the server ceiling) only if the full content is needed.`;
}

/** Read at most `limit` bytes of the body; cancels the rest and reports whether it was longer. */
async function readUpTo(response: Response, limit: number): Promise<{ bytes: Uint8Array; exceeded: boolean }> {
  if (!response.body) {
    return { bytes: new Uint8Array(0), exceeded: false };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let exceeded = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (total + value.byteLength > limit) {
      chunks.push(value.subarray(0, limit - total));
      total = limit;
      exceeded = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, exceeded };
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // ignore
  }
}

/**
 * Error bodies are read up to a small limit, only so DaluxHttpError can
 * recognise a documented code; nothing of the body is kept. A body over the
 * limit is discarded whole, never cut.
 */
async function readErrorBody(response: Response): Promise<unknown> {
  let read: { bytes: Uint8Array; exceeded: boolean };
  try {
    read = await readUpTo(response, MAX_ERROR_BODY_BYTES);
  } catch (error) {
    // A timeout or a dropped connection goes on as a transport error; anything else thrown while reading the body
    // is dropped with the body: the error is then the status alone.
    if (isTimeoutError(error) || isTransientNetworkError(error)) {
      throw error;
    }
    return null;
  }
  const { bytes, exceeded } = read;
  if (exceeded) {
    return null;
  }
  const text = new TextDecoder().decode(bytes);
  if (!text) {
    return null;
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (!exceeded && contentType.includes('application/json')) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
  return text;
}

/** System error codes a network error may name: a fixed list, so no other text from a cause is ever shown. */
const SHOWN_NETWORK_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/**
 * Reads a successful body. A timeout or a dropped connection goes on to execute(), which reports it as a transport
 * error; anything else thrown while reading is replaced by our own text, since its message is not ours.
 */
async function bodyRead<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (isTimeoutError(error) || isTransientNetworkError(error)) {
      throw error;
    }
    throw new Error('The Dalux response could not be read.');
  }
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await bodyRead(() => response.text());

  if (!text) {
    return null;
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return text;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** Comparable form of an API path: version prefix (e.g. /5.1) dropped, decoded, lower-cased. */
function resourceKey(path: string): string {
  const withoutVersion = path.replace(/^\/\d+(?:\.\d+)*(?=\/)/, '');
  let decoded: string;
  try {
    decoded = decodeURIComponent(withoutVersion);
  } catch {
    decoded = withoutVersion;
  }
  return trimTrailingSlash(decoded).toLowerCase();
}

function trimTrailingSlash(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') {
    end -= 1;
  }
  return value.slice(0, end);
}

function assertSafeBaseUrl(baseUrl: string, allowCustomHost: boolean): void {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error('DALUX_BASE_URL is not a valid URL.');
  }

  if (parsed.username || parsed.password || baseUrl.includes('?') || baseUrl.includes('#')) {
    throw new Error('DALUX_BASE_URL must not contain credentials, a query string or a fragment.');
  }

  if (isLocalHost(parsed.hostname) && (parsed.protocol === 'http:' || parsed.protocol === 'https:')) {
    return;
  }

  if (parsed.protocol !== 'https:') {
    throw new Error(
      'Refusing to send the Dalux API key without https. Use https:// (loopback http:// is allowed for local mocks).',
    );
  }

  const host = parsed.hostname.toLowerCase();
  if (host === 'dalux.com' || host.endsWith('.dalux.com') || allowCustomHost) {
    return;
  }

  throw new Error(
    'Refusing to send the Dalux API key to that host: DALUX_BASE_URL must be a *.dalux.com host. Set DALUX_ALLOW_CUSTOM_BASE_URL=true to allow another host.',
  );
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isLocalHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

/** Loopback, private, link-local or otherwise non-public host literals. */
function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return true;
  }
  const version = isIP(host);
  if (version === 4) {
    return isPrivateIPv4(host);
  }
  if (version === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host);
    if (mapped?.[1]) {
      return isPrivateIPv4(mapped[1]);
    }
    return (
      host === '::' ||
      host === '::1' ||
      /^f[cd][0-9a-f]{0,2}:/.test(host) ||
      /^fe[89ab][0-9a-f]?:/.test(host) ||
      /^::ffff:/.test(host)
    );
  }
  return false;
}

function isPrivateIPv4(host: string): boolean {
  const [a = 0, b = 0] = host.split('.').map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}
