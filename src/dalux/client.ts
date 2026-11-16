import { DaluxHttpError, formatUnknownError, parseRetryAfterMs, redactSecrets, registerSecret } from '../errors.js';
import { USER_AGENT } from '../version.js';

export interface DaluxClientOptions {
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Maximum number of concurrent requests to Dalux from this client (default 4, env DALUX_MAX_CONCURRENCY). */
  maxConcurrency?: number;
  /** Total attempts for idempotent GETs on 429/502/503/504 and network errors (default 3). */
  maxAttempts?: number;
  /** Base delay of the exponential backoff between retries (default 500 ms). */
  retryBaseDelayMs?: number;
  /** Upper bound on any single wait between retries, including Retry-After (default 30 s). */
  maxRetryDelayMs?: number;
  /** Allow a base URL outside *.dalux.com (env DALUX_ALLOW_CUSTOM_BASE_URL=true). */
  allowCustomBaseUrl?: boolean;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export type QueryValue = string | number | boolean | null | undefined;

type HttpMethod = 'GET' | 'POST' | 'PATCH';

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

/**
 * Client for the Dalux Build API (covers both the Field and Box modules).
 * Auth is a single X-API-KEY header issued per "API identity"; keys expire
 * and are scoped by the user groups assigned to the identity per project.
 *
 * Redirects are never followed automatically, so the key cannot be forwarded
 * to another origin. Idempotent GETs are retried with backoff on throttling,
 * gateway errors and network failures; POST/PATCH are never retried.
 */
export class DaluxClient {
  private readonly apiKey?: string;
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly retryBaseDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly semaphore: Semaphore;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: DaluxClientOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.DALUX_API_KEY;
    registerSecret(this.apiKey);
    this.baseUrl = trimTrailingSlash(
      options.baseUrl ?? process.env.DALUX_BASE_URL ?? 'https://field.dalux.com/service/api',
    );
    assertSafeBaseUrl(
      this.baseUrl,
      options.allowCustomBaseUrl ?? process.env.DALUX_ALLOW_CUSTOM_BASE_URL === 'true',
    );
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? readIntegerEnv('DALUX_TIMEOUT_MS', 30_000, { min: 1 });
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    this.retryBaseDelayMs = Math.max(0, options.retryBaseDelayMs ?? 500);
    this.maxRetryDelayMs = Math.max(0, options.maxRetryDelayMs ?? 30_000);
    this.semaphore = new Semaphore(
      options.maxConcurrency ?? readIntegerEnv('DALUX_MAX_CONCURRENCY', 4, { min: 1, max: 64 }),
    );
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  }

  async get<T>(path: string, query?: Record<string, QueryValue>): Promise<T> {
    return this.request<T>('GET', this.buildUrl(path, query));
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
    const url = this.buildUrl(path);
    const headers = this.headers();

    return this.execute('GET', url, { method: 'GET', headers }, async (first, signal) => {
      let response = first;
      let responseUrl = url;

      if (isRedirect(response.status)) {
        const target = this.redirectTarget(response, url);
        await discardBody(response);
        const sameOrigin = target.origin === new URL(this.baseUrl).origin;
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
          throw this.transportError('GET', responseUrl, error);
        }
        if (isRedirect(response.status)) {
          await discardBody(response);
          throw new Error(
            redactSecrets(`Dalux download redirected more than once (HTTP ${response.status}); not following.`),
          );
        }
      }

      if (!response.ok) {
        const payload = await readResponseBody(response);
        throw new DaluxHttpError({
          status: response.status,
          url: responseUrl,
          payload,
          retryAfter: response.headers.get('retry-after') ?? undefined,
        });
      }

      const declared = Number(response.headers.get('content-length') ?? 0);
      if (Number.isFinite(declared) && declared > maxBytes) {
        await discardBody(response);
        throw new Error(tooLargeMessage(`${declared} bytes`, maxBytes));
      }

      return {
        bytes: await readCapped(response, maxBytes),
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
    const base = new URL(this.baseUrl);
    let target: URL;
    try {
      target = new URL(href);
    } catch {
      throw new Error(`Refusing to follow invalid link: ${href}`);
    }
    if (target.origin !== base.origin) {
      throw new Error(`Refusing to follow link outside ${base.origin}: ${target.origin}`);
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
      throw new Error(`Refusing to follow link outside the API base path ${basePath || '/'}.`);
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
        throw new Error(
          redactSecrets(
            `Dalux API responded with an unexpected redirect (HTTP ${response.status}) for ${method} ${url}; redirects are not followed.`,
          ),
        );
      }

      const responseBody = await readResponseBody(response);
      if (!response.ok) {
        throw new DaluxHttpError({
          status: response.status,
          url,
          payload: responseBody,
          retryAfter: response.headers.get('retry-after') ?? undefined,
        });
      }

      return responseBody as T;
    });
  }

  /**
   * Run one logical request: limit concurrency, apply the timeout, and retry
   * idempotent GETs on retryable statuses and network errors. `handle` runs
   * while the concurrency slot is held, so body reads count against it.
   */
  private async execute<R>(
    method: HttpMethod,
    url: string,
    init: RequestInit,
    handle: (response: Response, signal: AbortSignal) => Promise<R>,
  ): Promise<R> {
    const maxAttempts = method === 'GET' ? this.maxAttempts : 1;

    for (let attempt = 1; ; attempt += 1) {
      let delayMs = 0;
      const release = await this.semaphore.acquire();
      try {
        const signal = AbortSignal.timeout(this.timeoutMs);
        let response: Response | undefined;
        try {
          response = await this.fetchImpl(url, { ...init, redirect: 'manual', signal });
        } catch (error) {
          if (attempt >= maxAttempts || !isNetworkError(error)) {
            throw this.transportError(method, url, error);
          }
          delayMs = this.backoffDelay(attempt);
        }

        if (response) {
          if (attempt >= maxAttempts || !RETRYABLE_STATUS.has(response.status)) {
            return await handle(response, signal);
          }
          const retryAfter = parseRetryAfterMs(response.headers.get('retry-after'));
          delayMs = Math.min(retryAfter ?? this.backoffDelay(attempt), this.maxRetryDelayMs);
          await discardBody(response);
        }
      } finally {
        release();
      }
      // Wait outside the concurrency slot.
      await this.sleep(delayMs);
    }
  }

  private backoffDelay(attempt: number): number {
    const exponential = this.retryBaseDelayMs * 2 ** (attempt - 1);
    const jitter = Math.random() * this.retryBaseDelayMs;
    return Math.min(exponential + jitter, this.maxRetryDelayMs);
  }

  private redirectTarget(response: Response, requestUrl: string): URL {
    const location = response.headers.get('location');
    if (!location) {
      throw new Error(`Dalux download responded with HTTP ${response.status} without a Location header.`);
    }
    let target: URL;
    try {
      target = new URL(location, requestUrl);
    } catch {
      throw new Error('Dalux download redirected to an invalid URL; not following.');
    }
    if (target.protocol !== 'https:') {
      throw new Error(`Refusing to follow download redirect over ${target.protocol}// (https only).`);
    }
    return target;
  }

  private transportError(method: HttpMethod, url: string, error: unknown): Error {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      return new Error(redactSecrets(`Dalux request timed out after ${this.timeoutMs} ms (${method} ${url}).`));
    }
    const cause = error instanceof Error && error.cause !== undefined ? formatUnknownError(error.cause) : undefined;
    const message = `Network error calling Dalux (${method} ${url}): ${formatUnknownError(error)}${cause ? ` (cause: ${cause})` : ''}`;
    return new Error(redactSecrets(message), { cause: error });
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
  const min = bounds.min ?? Number.MIN_SAFE_INTEGER;
  const max = bounds.max ?? Number.MAX_SAFE_INTEGER;
  if (!/^-?\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) {
    const range = bounds.max === undefined ? `>= ${min}` : `between ${min} and ${max}`;
    throw new Error(`${name} must be an integer ${range} (got "${raw}").`);
  }
  return value;
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

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

function isNetworkError(error: unknown): boolean {
  // fetch reports connection failures as TypeError; timeouts are not retried.
  return error instanceof TypeError;
}

function tooLargeMessage(size: string, maxBytes: number): string {
  return `Download aborted: file is ${size}, which exceeds the ${maxBytes} byte limit. Raise maxBytes (up to the server ceiling) only if the full content is needed.`;
}

async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) {
    return new Uint8Array(0);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(tooLargeMessage(`more than ${maxBytes} bytes`, maxBytes));
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // ignore
  }
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();

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
    throw new Error(`DALUX_BASE_URL is not a valid URL: ${baseUrl}`);
  }

  if (isLocalHost(parsed.hostname) && (parsed.protocol === 'http:' || parsed.protocol === 'https:')) {
    return;
  }

  if (parsed.protocol !== 'https:') {
    throw new Error(
      `Refusing to send the Dalux API key over ${parsed.protocol}//. Use https:// (loopback http:// is allowed for local mocks).`,
    );
  }

  const host = parsed.hostname.toLowerCase();
  if (host === 'dalux.com' || host.endsWith('.dalux.com') || allowCustomHost) {
    return;
  }

  throw new Error(
    `Refusing to send the Dalux API key to ${host}: DALUX_BASE_URL must be a *.dalux.com host. Set DALUX_ALLOW_CUSTOM_BASE_URL=true to allow another host.`,
  );
}

function isLocalHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}
