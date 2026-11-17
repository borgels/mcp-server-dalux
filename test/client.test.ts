import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DaluxClient, readIntegerEnv } from '../src/dalux/client.js';
import { DaluxHttpError, parseRetryAfterMs, redactSecrets } from '../src/errors.js';
import { PACKAGE_VERSION, USER_AGENT } from '../src/version.js';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

type Handler = (url: string, init?: RequestInit) => Response | unknown | Promise<Response | unknown>;

function makeFetch(handler: Handler) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const result = await handler(String(input), init);
    if (result instanceof Response) {
      return result;
    }
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

function jsonResponse(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function headersOf(init?: RequestInit): Record<string, string> {
  return (init?.headers ?? {}) as Record<string, string>;
}

const noSleep = vi.fn(async (_ms: number) => undefined);

function makeClient(fetchImpl: typeof fetch, extra: Partial<ConstructorParameters<typeof DaluxClient>[0]> = {}) {
  return new DaluxClient({ apiKey: 'k', fetchImpl, sleep: noSleep, ...extra });
}

describe('DaluxClient', () => {
  it('sends the X-API-KEY and User-Agent headers and builds versioned URLs', async () => {
    let seenUrl = '';
    let seenInit: RequestInit | undefined;
    const fetchImpl = makeFetch((url, init) => {
      seenUrl = url;
      seenInit = init;
      return { link: {}, items: [] };
    });

    const client = new DaluxClient({ apiKey: 'secret-key', fetchImpl });
    await client.get('/5.1/projects');

    expect(seenUrl).toBe('https://field.dalux.com/service/api/5.1/projects');
    expect(headersOf(seenInit)['X-API-KEY']).toBe('secret-key');
    expect(headersOf(seenInit)['User-Agent']).toBe(`mcp-server-dalux/${PACKAGE_VERSION}`);
    expect(seenInit?.redirect).toBe('manual');
  });

  it('keeps the version constant in sync with package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(PACKAGE_VERSION).toBe(pkg.version);
    expect(USER_AGENT).toBe(`mcp-server-dalux/${pkg.version}`);
  });

  it('throws before sending anything when the API key is missing', async () => {
    const fetchImpl = makeFetch(() => ({}));
    delete process.env.DALUX_API_KEY;
    const client = new DaluxClient({ fetchImpl });

    await expect(client.get('/5.1/projects')).rejects.toThrow('DALUX_API_KEY');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses non-https base URLs and links outside the API origin', async () => {
    expect(() => new DaluxClient({ apiKey: 'k', baseUrl: 'http://evil.example.com' })).toThrow('https://');

    const client = new DaluxClient({ apiKey: 'k', fetchImpl: makeFetch(() => ({})) });
    await expect(client.getAbsolute('https://evil.example.com/steal')).rejects.toThrow('outside');
  });

  it('only allows *.dalux.com base URLs unless explicitly overridden', () => {
    expect(() => new DaluxClient({ apiKey: 'k', baseUrl: 'https://field.dalux.com/service/api' })).not.toThrow();
    expect(() => new DaluxClient({ apiKey: 'k', baseUrl: 'https://other.dalux.com/api' })).not.toThrow();
    expect(() => new DaluxClient({ apiKey: 'k', baseUrl: 'http://127.0.0.1:8080/api' })).not.toThrow();
    expect(() => new DaluxClient({ apiKey: 'k', baseUrl: 'http://localhost:8080/api' })).not.toThrow();

    expect(() => new DaluxClient({ apiKey: 'k', baseUrl: 'https://example.com/api' })).toThrow('*.dalux.com');
    expect(() => new DaluxClient({ apiKey: 'k', baseUrl: 'https://dalux.com.example.net/api' })).toThrow(
      'DALUX_ALLOW_CUSTOM_BASE_URL',
    );
    expect(() => new DaluxClient({ apiKey: 'k', baseUrl: 'https://notdalux.com/api' })).toThrow();

    expect(
      () => new DaluxClient({ apiKey: 'k', baseUrl: 'https://example.com/api', allowCustomBaseUrl: true }),
    ).not.toThrow();
    process.env.DALUX_ALLOW_CUSTOM_BASE_URL = 'true';
    expect(() => new DaluxClient({ apiKey: 'k', baseUrl: 'https://example.com/api' })).not.toThrow();
    // The override never permits plain http to a remote host.
    expect(() => new DaluxClient({ apiKey: 'k', baseUrl: 'http://example.com/api' })).toThrow('https://');
  });

  it('validates numeric environment variables instead of producing NaN', () => {
    process.env.TEST_INT = 'abc';
    expect(() => readIntegerEnv('TEST_INT', 1)).toThrow('TEST_INT must be an integer');
    process.env.TEST_INT = '1.5';
    expect(() => readIntegerEnv('TEST_INT', 1)).toThrow();
    process.env.TEST_INT = '0';
    expect(() => readIntegerEnv('TEST_INT', 1, { min: 1 })).toThrow('>= 1');
    process.env.TEST_INT = ' 42 ';
    expect(readIntegerEnv('TEST_INT', 1)).toBe(42);
    process.env.TEST_INT = '';
    expect(readIntegerEnv('TEST_INT', 7)).toBe(7);

    process.env.DALUX_TIMEOUT_MS = '30s';
    expect(() => new DaluxClient({ apiKey: 'k' })).toThrow('DALUX_TIMEOUT_MS');
    delete process.env.DALUX_TIMEOUT_MS;
    process.env.DALUX_MAX_CONCURRENCY = 'many';
    expect(() => new DaluxClient({ apiKey: 'k' })).toThrow('DALUX_MAX_CONCURRENCY');
    delete process.env.DALUX_MAX_CONCURRENCY;
    process.env.DALUX_TIMEOUT_MS = '3000000000';
    expect(() => new DaluxClient({ apiKey: 'k' })).toThrow('DALUX_TIMEOUT_MS');
    delete process.env.DALUX_TIMEOUT_MS;
    process.env.DALUX_MAX_DOWNLOAD_BYTES = '25MB';
    expect(() => new DaluxClient({ apiKey: 'k' })).toThrow('DALUX_MAX_DOWNLOAD_BYTES');
    process.env.DALUX_MAX_DOWNLOAD_BYTES = String(200 * 1024 * 1024);
    expect(() => new DaluxClient({ apiKey: 'k' })).toThrow('DALUX_MAX_DOWNLOAD_BYTES');
  });

  it('validates numeric options', () => {
    expect(() => new DaluxClient({ apiKey: 'k', maxConcurrency: 0 })).toThrow('maxConcurrency');
    expect(() => new DaluxClient({ apiKey: 'k', maxConcurrency: Number.NaN })).toThrow('maxConcurrency');
    expect(() => new DaluxClient({ apiKey: 'k', timeoutMs: 2 ** 31 })).toThrow('timeoutMs');
    expect(() => new DaluxClient({ apiKey: 'k', maxAttempts: 0 })).toThrow('maxAttempts');
  });

  it('rejects base URLs with credentials, query or fragment without echoing them', () => {
    for (const baseUrl of [
      'https://user:hunter2@field.dalux.com/service/api',
      'https://field.dalux.com/service/api?x=1',
      'https://field.dalux.com/service/api#frag',
    ]) {
      let message = '';
      try {
        new DaluxClient({ apiKey: 'k', baseUrl });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain('credentials, a query string or a fragment');
      expect(message).not.toContain('hunter2');
    }
    expect(() => new DaluxClient({ apiKey: 'k', baseUrl: 'http://[::1]:8080/api' })).not.toThrow();
  });
});

describe('error handling', () => {
  it('gives the status, a documented code and our hint, never Dalux text', async () => {
    const fetchImpl = makeFetch(() =>
      jsonResponse(
        {
          httpStatusCode: 401,
          errorCode: 'E40101',
          errorCodeMessage: 'ApiKeyValidationFailed',
          message: 'Unrecognized api key',
          developerHint: 'See the key',
          errors: [{ propertyName: 'bookmark', errorMessage: "Malformed parameter 'bookmark'" }],
        },
        401,
      ),
    );
    const error = await makeClient(fetchImpl).get('/5.1/projects').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DaluxHttpError);
    expect((error as DaluxHttpError).status).toBe(401);
    expect((error as DaluxHttpError).errorCode).toBe('E40101');
    const message = (error as Error).message;
    expect(message).toContain('HTTP 401');
    expect(message).toContain('E40101');
    expect(message).toContain('DALUX_API_KEY');
    for (const vendor of ['ApiKeyValidationFailed', 'Unrecognized', 'See the key', 'bookmark']) {
      expect(message).not.toContain(vendor);
    }

    const processing = makeFetch(() => jsonResponse({ errorCode: 'E40005', message: 'Not all parts uploaded' }, 400));
    await expect(makeClient(processing).get('/x')).rejects.toThrow(/retry the same call later/);
    const feature = makeFetch(() => jsonResponse({ httpStatusCode: 403, errorCode: 'E40301' }, 403));
    await expect(makeClient(feature).get('/x')).rejects.toThrow(/not available for this project/);
    const items = makeFetch(() => jsonResponse({ httpStatusCode: 404, errorCode: 'E40402' }, 404));
    await expect(makeClient(items).get('/x')).rejects.toThrow(/user groups/);
    const legacy = makeFetch(() => jsonResponse({ code: 'E40401', error: 'NotFound', message: 'gone' }, 404));
    const legacyError = (await makeClient(legacy).get('/x').catch((e: unknown) => e)) as DaluxHttpError;
    expect(legacyError.errorCode).toBe('E40401');
    expect(legacyError.message).not.toMatch(/NotFound|gone/);
  });

  it('keeps only documented error codes', async () => {
    for (const code of ['constructor', 'E99999', 'secret-ish-code', 42]) {
      const fetchImpl = makeFetch(() => jsonResponse({ errorCode: code, message: 'odd' }, 400));
      const error = (await makeClient(fetchImpl).get('/x').catch((e: unknown) => e)) as DaluxHttpError;
      expect(error.errorCode, String(code)).toBeUndefined();
      expect(error.message, String(code)).toBe('Dalux API request failed with HTTP 400');
    }
  });

  it('never puts an error body in the error', async () => {
    const apiKey = 'live-key-0123456789abcdef';
    const html = `<html>${'x'.repeat(5000)} ${apiKey}</html>`;
    const fetchImpl = makeFetch(() => new Response(html, { status: 500, headers: { 'content-type': 'text/html' } }));
    const client = new DaluxClient({ apiKey, fetchImpl, sleep: noSleep, maxAttempts: 1 });
    const error = (await client.get('/x').catch((e: unknown) => e)) as DaluxHttpError;
    expect(error.message).toBe('Dalux API request failed with HTTP 500');
    expect(JSON.stringify(error)).not.toContain('xxxx');
    expect(client.redactor.redact(`key is ${apiKey}`)).toBe('key is ‹redacted›');
    // No process-wide registry: without the instance redactor the key is unknown.
    expect(redactSecrets(`key is ${apiKey}`)).toBe(`key is ${apiKey}`);
    expect(redactSecrets('X-API-KEY: abc123')).not.toContain('abc123');
    expect(redactSecrets('DALUX_API_KEY=abc123')).not.toContain('abc123');
  });

  it('recognises "no task changes" without keeping the body', async () => {
    const fetchImpl = makeFetch(() => jsonResponse({ message: 'No task changes on project.' }, 404));
    const error = (await makeClient(fetchImpl).get('/x').catch((e: unknown) => e)) as DaluxHttpError;
    expect(error.condition).toBe('no_task_changes');
    expect(error.message).not.toContain('No task changes');
  });

  it('parses Retry-After as seconds or an HTTP date', async () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(parseRetryAfterMs('5', now)).toBe(5000);
    expect(parseRetryAfterMs('Thu, 01 Jan 2026 00:00:10 GMT', now)).toBe(10_000);
    // Zero, past dates and malformed values mean "use your own backoff".
    for (const value of ['0', 'Wed, 31 Dec 2025 23:59:00 GMT', 'soon', '1.5', '-1', '+5', '5, 10', 'soon 2020', '']) {
      expect(parseRetryAfterMs(value, now)).toBeUndefined();
    }
    expect(parseRetryAfterMs(null, now)).toBeUndefined();

    const date = new Date(Date.now() + 60_000).toUTCString();
    const fetchImpl = makeFetch(() => jsonResponse({ errorCode: 'E50001' }, 429, { 'retry-after': date }));
    const message = await makeClient(fetchImpl, { maxAttempts: 1 })
      .get('/x')
      .catch((e: Error) => e.message);
    expect(message).toMatch(/retry-after=\d+s/);
  });

  it('names only the system error code of a network error, never its message', async () => {
    const fetchImpl = makeFetch(() => {
      throw new TypeError('fetch failed somewhere odd', {
        cause: Object.assign(new Error('getaddrinfo ENOTFOUND field.dalux.com'), { code: 'ENOTFOUND' }),
      });
    });
    const message = await makeClient(fetchImpl, { maxAttempts: 1 })
      .get('/x')
      .catch((e: Error) => e.message);
    expect(message).toMatch(/Network error calling Dalux \(GET\) \(ENOTFOUND\)\./);
    expect(message).not.toMatch(/odd|getaddrinfo/);
  });

  it('reads at most 64 KB of an error body', async () => {
    let pulled = 0;
    const fetchImpl = makeFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              pulled += 1;
              controller.enqueue(new TextEncoder().encode('e'.repeat(16 * 1024)));
            },
          }),
          { status: 500, headers: { 'content-type': 'text/html' } },
        ),
    );
    const error = (await makeClient(fetchImpl)
      .get('/x')
      .catch((e: unknown) => e)) as DaluxHttpError;
    expect(error).toBeInstanceOf(DaluxHttpError);
    expect(pulled).toBeLessThan(10);
    expect(error.message.length).toBeLessThan(700);
  });

  it('keeps query strings out of error URLs', async () => {
    const fetchImpl = makeFetch(() => jsonResponse({ errorCode: 'E40002' }, 400));
    const error = (await makeClient(fetchImpl)
      .get('/5.1/projects', { bookmark: 'secret-bookmark' })
      .catch((e: unknown) => e)) as DaluxHttpError;
    expect(error.url).toBe('https://field.dalux.com/service/api/5.1/projects');
  });

  it('reports timeouts while reading the body clearly', async () => {
    const fetchImpl = makeFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.error(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    await expect(makeClient(fetchImpl).get('/5.1/projects?bookmark=b')).rejects.toThrow(
      /timed out after \d+ ms \(GET\)/,
    );
  });
});

describe('redirects', () => {
  it('never follows redirects on JSON calls and names the target', async () => {
    const fetchImpl = makeFetch(
      () => new Response(null, { status: 302, headers: { location: 'https://node2.dalux.com/service/api/5.1/projects?t=1' } }),
    );
    const message = await makeClient(fetchImpl)
      .get('/5.1/projects')
      .catch((e: Error) => e.message);
    expect(message).toContain('redirect (HTTP 302) for GET');
    expect(message).toContain('DALUX_BASE_URL');
    // The Location is Dalux's text: never quoted.
    expect(message).not.toContain('node2');
    await expect(makeClient(fetchImpl).post('/1.0/x', {})).rejects.toThrow(/redirect/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.every(([url]) => !String(url).includes('node2'))).toBe(true);
  });

  it('keeps signed redirect URLs out of download errors', async () => {
    const fetchImpl = makeFetch(url => {
      if (url.startsWith('https://field.dalux.com/')) {
        return new Response(null, { status: 302, headers: { location: 'https://storage.example.net/blob?sig=SIGNED' } });
      }
      if (url.includes('blob')) {
        return new Response('denied sig=SIGNED', { status: 403, headers: { 'content-type': 'text/plain' } });
      }
      return {};
    });
    const error = (await makeClient(fetchImpl)
      .getBinary('/2.0/x/content', 100)
      .catch((e: unknown) => e)) as DaluxHttpError;
    expect(error.url).toBe('https://storage.example.net/blob');

    const failing = makeFetch(url => {
      if (url.startsWith('https://field.dalux.com/')) {
        return new Response(null, { status: 302, headers: { location: 'https://storage.example.net/blob?sig=SIGNED' } });
      }
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) });
    });
    const message = await makeClient(failing, { maxAttempts: 1 })
      .getBinary('/2.0/x/content', 100)
      .catch((e: Error) => e.message);
    expect(message).toContain('Network error calling Dalux');
    expect(message).not.toContain('storage.example.net');
    expect(message).not.toContain('SIGNED');
  });

  it('refuses cross-origin download redirects to local or private addresses', async () => {
    for (const location of [
      'https://127.0.0.1/x',
      'https://10.1.2.3/x',
      'https://192.168.0.1/x',
      'https://169.254.169.254/latest',
      'https://[::1]/x',
      'https://[fd00::1]/x',
      'https://localhost/x',
    ]) {
      const fetchImpl = makeFetch(() => new Response(null, { status: 302, headers: { location } }));
      await expect(makeClient(fetchImpl).getBinary('/2.0/x/content', 100)).rejects.toThrow('local or private');
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it('cancels the body of a refused redirect', async () => {
    let cancelled = false;
    const fetchImpl = makeFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              cancelled = true;
            },
          }),
          { status: 302, headers: { location: 'http://storage.example.net/x' } },
        ),
    );
    await expect(makeClient(fetchImpl).getBinary('/2.0/x/content', 100)).rejects.toThrow('not https');
    expect(cancelled).toBe(true);
  });

  it('never fetches a download redirect whose URL carries the API key', async () => {
    const VENDORLIKE = 'Zq7pX2vK9mWb4TnR8yLc3HdJ6fGs1QeU';
    const fetchImpl = makeFetch(url =>
      url.startsWith('https://field.dalux.com/')
        ? new Response(null, { status: 302, headers: { location: `https://storage.example.net/blob?credential=${VENDORLIKE}` } })
        : new Response('bytes', { status: 200 }),
    );
    await expect(makeClient(fetchImpl, { apiKey: VENDORLIKE }).getBinary('/2.0/x/content', 100)).rejects.toThrow(
      'carries the API key',
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('follows one download redirect cross-origin without the API key', async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl = makeFetch((url, init) => {
      seen.push({ url, headers: headersOf(init) });
      if (url.startsWith('https://field.dalux.com/')) {
        return new Response(null, { status: 302, headers: { location: 'https://storage.example.net/blob/1?sig=x' } });
      }
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      });
    });

    const result = await makeClient(fetchImpl).getBinary('/2.0/x/content', 100);
    expect(Array.from(result.bytes)).toEqual([1, 2, 3]);
    expect(seen).toHaveLength(2);
    expect(seen[0]?.headers['X-API-KEY']).toBe('k');
    expect(seen[1]?.url).toBe('https://storage.example.net/blob/1?sig=x');
    expect(seen[1]?.headers['X-API-KEY']).toBeUndefined();
    expect(Object.keys(seen[1]?.headers ?? {}).map(h => h.toLowerCase())).not.toContain('x-api-key');
    expect(seen[1]?.headers['User-Agent']).toBe(USER_AGENT);
  });

  it('keeps the API key on a same-origin download redirect', async () => {
    const seen: Array<Record<string, string>> = [];
    const fetchImpl = makeFetch((url, init) => {
      seen.push(headersOf(init));
      if (url.endsWith('/content')) {
        return new Response(null, { status: 307, headers: { location: '/service/api/2.0/x/content-v2' } });
      }
      return new Response('hello', { status: 200, headers: { 'content-type': 'text/plain' } });
    });

    const result = await makeClient(fetchImpl).getBinary('/2.0/x/content', 100);
    expect(new TextDecoder().decode(result.bytes)).toBe('hello');
    expect(seen[1]?.['X-API-KEY']).toBe('k');
  });

  it('refuses non-https and repeated download redirects', async () => {
    const toHttp = makeFetch(() => new Response(null, { status: 302, headers: { location: 'http://storage.example.net/x' } }));
    await expect(makeClient(toHttp).getBinary('/2.0/x/content', 100)).rejects.toThrow('not https');
    expect(toHttp).toHaveBeenCalledTimes(1);

    const loop = makeFetch(() => new Response(null, { status: 302, headers: { location: 'https://storage.example.net/x' } }));
    await expect(makeClient(loop).getBinary('/2.0/x/content', 100)).rejects.toThrow('more than once');
    expect(loop).toHaveBeenCalledTimes(2);
  });
});

describe('downloads', () => {
  it('rejects up front when Content-Length exceeds the cap', async () => {
    const fetchImpl = makeFetch(
      () =>
        new Response(new Uint8Array(64), {
          status: 200,
          headers: { 'content-type': 'application/pdf', 'content-length': '64' },
        }),
    );
    const client = makeClient(fetchImpl);

    await expect(client.getBinary('/2.0/x/content', 10)).rejects.toThrow('exceeds');
    const ok = await client.getBinary('/2.0/x/content', 100);
    expect(ok.bytes.byteLength).toBe(64);
    expect(ok.contentType).toBe('application/pdf');
  });

  it('aborts while streaming when the cap is exceeded without Content-Length', async () => {
    let pulled = 0;
    let cancelled = false;
    const totalChunks = 1000;
    const fetchImpl = makeFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              pulled += 1;
              if (pulled > totalChunks) {
                controller.close();
                return;
              }
              controller.enqueue(new Uint8Array(1024));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status: 200, headers: { 'content-type': 'application/octet-stream' } },
        ),
    );

    await expect(makeClient(fetchImpl).getBinary('/2.0/x/content', 4096)).rejects.toThrow('exceeds the 4096 byte limit');
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(20);
  });
});

describe('retries and concurrency', () => {
  it('retries idempotent GETs on 429/502/503/504 honouring Retry-After', async () => {
    const statuses = [503, 429];
    const fetchImpl = makeFetch(() => {
      const status = statuses.shift();
      if (status === 429) {
        return jsonResponse({}, 429, { 'retry-after': '2' });
      }
      if (status) {
        return jsonResponse({}, status);
      }
      return { ok: true };
    });
    const sleep = vi.fn(async (_ms: number) => undefined);
    const client = makeClient(fetchImpl, { sleep, retryBaseDelayMs: 10 });

    await expect(client.get('/x')).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls[1]).toEqual([2000]);
  });

  it('does not wait for a Retry-After beyond the retry budget and surfaces it', async () => {
    const fetchImpl = makeFetch(() => jsonResponse({ errorCode: 'E50001' }, 503, { 'retry-after': '3600' }));
    const sleep = vi.fn(async (_ms: number) => undefined);
    const error = (await makeClient(fetchImpl, { sleep })
      .get('/x')
      .catch((e: unknown) => e)) as DaluxHttpError;

    expect(error).toBeInstanceOf(DaluxHttpError);
    expect(error.message).toContain('retry-after=3600s');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('uses backoff for Retry-After 0 or junk and gives up after three attempts', async () => {
    const fetchImpl = makeFetch(() => jsonResponse({}, 429, { 'retry-after': '0' }));
    const sleep = vi.fn(async (_ms: number) => undefined);
    await expect(makeClient(fetchImpl, { sleep, retryBaseDelayMs: 100 }).get('/x')).rejects.toBeInstanceOf(
      DaluxHttpError,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const waits = sleep.mock.calls.map(([ms]) => ms);
    expect(waits[0]).toBeGreaterThanOrEqual(100);
    expect(waits[1]).toBeGreaterThanOrEqual(200);
  });

  it('keeps total retry waiting within the budget', async () => {
    const fetchImpl = makeFetch(() => jsonResponse({}, 503, { 'retry-after': '6' }));
    const sleep = vi.fn(async (_ms: number) => undefined);
    await expect(makeClient(fetchImpl, { sleep }).get('/x')).rejects.toBeInstanceOf(DaluxHttpError);
    // 6 s fits in the 10 s budget once, not twice.
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([6000]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retries GETs on transient network errors only', async () => {
    let calls = 0;
    const fetchImpl = makeFetch(() => {
      calls += 1;
      if (calls === 1) {
        throw new TypeError('fetch failed', { cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) });
      }
      return { ok: true };
    });
    await expect(makeClient(fetchImpl).get('/x')).resolves.toEqual({ ok: true });
    expect(calls).toBe(2);

    const permanent = makeFetch(() => {
      throw new TypeError('Headers.append: invalid header value');
    });
    await expect(makeClient(permanent).get('/x')).rejects.toThrow('Network error');
    expect(permanent).toHaveBeenCalledTimes(1);
  });

  it('retries GETs when the connection drops while reading the body', async () => {
    let calls = 0;
    const fetchImpl = makeFetch(() => {
      calls += 1;
      if (calls === 1) {
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.error(new TypeError('terminated', { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) }));
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return { ok: true };
    });
    await expect(makeClient(fetchImpl).get('/x')).resolves.toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  it('releases the concurrency slot after failures', async () => {
    let calls = 0;
    const fetchImpl = makeFetch(() => {
      calls += 1;
      if (calls === 1) {
        throw new DOMException('timeout', 'TimeoutError');
      }
      if (calls === 2) {
        return jsonResponse({}, 500);
      }
      return { ok: true };
    });
    const client = makeClient(fetchImpl, { maxConcurrency: 1 });
    await expect(client.get('/x')).rejects.toThrow('timed out');
    await expect(client.get('/x')).rejects.toBeInstanceOf(DaluxHttpError);
    await expect(client.get('/x')).resolves.toEqual({ ok: true });
  });

  it('never retries POST or PATCH', async () => {
    const fetchImpl = makeFetch(() => jsonResponse({}, 503));
    const client = makeClient(fetchImpl);
    await expect(client.post('/x', {})).rejects.toBeInstanceOf(DaluxHttpError);
    await expect(client.patch('/x', {})).rejects.toBeInstanceOf(DaluxHttpError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const failing = makeFetch(() => {
      throw new TypeError('fetch failed');
    });
    await expect(makeClient(failing).post('/x', {})).rejects.toThrow('Network error');
    expect(failing).toHaveBeenCalledTimes(1);
  });

  it('limits concurrent requests per client', async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchImpl = makeFetch(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise(resolve => setTimeout(resolve, 5));
      inFlight -= 1;
      return { ok: true };
    });
    const client = makeClient(fetchImpl, { maxConcurrency: 2 });

    await Promise.all(Array.from({ length: 8 }, () => client.get('/x')));
    expect(fetchImpl).toHaveBeenCalledTimes(8);
    expect(peak).toBe(2);
  });
});
