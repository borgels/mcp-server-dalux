import { DaluxHttpError } from '../errors.js';

export interface DaluxClientOptions {
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export type QueryValue = string | number | boolean | null | undefined;

/**
 * Client for the Dalux Build API (covers both the Field and Box modules).
 * Auth is a single X-API-KEY header issued per "API identity"; keys expire
 * and are scoped by the user groups assigned to the identity per project.
 */
export class DaluxClient {
  private readonly apiKey?: string;
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: DaluxClientOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.DALUX_API_KEY;
    this.baseUrl = trimTrailingSlash(
      options.baseUrl ?? process.env.DALUX_BASE_URL ?? 'https://field.dalux.com/service/api',
    );
    assertSafeBaseUrl(this.baseUrl);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? Number(process.env.DALUX_TIMEOUT_MS ?? 30_000);
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

  async postBinary<T>(path: string, body: Uint8Array): Promise<T> {
    return this.request<T>('POST', this.buildUrl(path), body, 'application/octet-stream');
  }

  async patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PATCH', this.buildUrl(path), body);
  }

  /** Fetch binary content (file downloads). Enforces a byte cap. */
  async getBinary(path: string, maxBytes: number): Promise<{ bytes: Uint8Array; contentType: string }> {
    const url = this.buildUrl(path);
    const response = await this.fetchImpl(url, {
      method: 'GET',
      headers: this.headers(),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      const payload = await readResponseBody(response);
      throw new DaluxHttpError({
        status: response.status,
        url,
        payload,
        retryAfter: response.headers.get('retry-after') ?? undefined,
      });
    }

    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > maxBytes) {
      throw new Error(
        `File is ${declared} bytes which exceeds the ${maxBytes} byte limit. Increase maxBytes if you really need it.`,
      );
    }

    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) {
      throw new Error(
        `File is ${buffer.byteLength} bytes which exceeds the ${maxBytes} byte limit. Increase maxBytes if you really need it.`,
      );
    }

    return {
      bytes: buffer,
      contentType: response.headers.get('content-type') ?? 'application/octet-stream',
    };
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
      'X-API-KEY': this.apiKey,
      ...extra,
    };
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    body?: unknown,
    contentType?: string,
  ): Promise<T> {
    const headers = this.headers();
    const init: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(this.timeoutMs),
    };

    if (body !== undefined) {
      if (body instanceof Uint8Array) {
        headers['Content-Type'] = contentType ?? 'application/octet-stream';
        init.body = body as unknown as RequestInit['body'];
      } else {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
    }

    const response = await this.fetchImpl(url, init);
    const responseBody = await readResponseBody(response);

    if (!response.ok) {
      throw new DaluxHttpError({
        status: response.status,
        url,
        payload: responseBody,
        retryAfter: response.headers.get('retry-after') ?? undefined,
        fallbackMessage: typeof responseBody === 'string' ? responseBody : undefined,
      });
    }

    return responseBody as T;
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

function assertSafeBaseUrl(baseUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`DALUX_BASE_URL is not a valid URL: ${baseUrl}`);
  }

  if (parsed.protocol === 'https:') {
    return;
  }

  if (parsed.protocol === 'http:' && isLocalHost(parsed.hostname)) {
    return;
  }

  throw new Error(
    `Refusing to send the Dalux API key over ${parsed.protocol}//. Use https:// (loopback http:// is allowed for local mocks).`,
  );
}

function isLocalHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}
