import { describe, expect, it, vi } from 'vitest';
import { DaluxClient } from '../src/dalux/client.js';
import { DaluxHttpError, redactSecrets } from '../src/errors.js';

function makeFetch(handler: (url: string, init?: RequestInit) => Response | unknown) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const result = handler(String(input), init);
    if (result instanceof Response) {
      return result;
    }
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

describe('DaluxClient', () => {
  it('sends the X-API-KEY header and builds versioned URLs', async () => {
    let seenUrl = '';
    let seenHeaders: Record<string, string> = {};
    const fetchImpl = makeFetch((url, init) => {
      seenUrl = url;
      seenHeaders = init?.headers as Record<string, string>;
      return { link: {}, items: [] };
    });

    const client = new DaluxClient({ apiKey: 'secret-key', fetchImpl });
    await client.get('/5.1/projects');

    expect(seenUrl).toBe('https://field.dalux.com/service/api/5.1/projects');
    expect(seenHeaders['X-API-KEY']).toBe('secret-key');
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

  it('wraps API errors with status and payload, and redacts keys from messages', async () => {
    const fetchImpl = makeFetch(
      () =>
        new Response(JSON.stringify({ code: 'E40101', message: 'ApiKeyValidationFailed' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const client = new DaluxClient({ apiKey: 'k', fetchImpl });

    const error = await client.get('/5.1/projects').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DaluxHttpError);
    expect((error as DaluxHttpError).status).toBe(401);
    expect((error as Error).message).toContain('E40101');

    expect(redactSecrets('X-API-KEY: abc123')).not.toContain('abc123');
    expect(redactSecrets('DALUX_API_KEY=abc123')).not.toContain('abc123');
  });

  it('enforces the byte cap on binary downloads', async () => {
    const fetchImpl = makeFetch(
      () =>
        new Response(new Uint8Array(64), {
          status: 200,
          headers: { 'content-type': 'application/pdf', 'content-length': '64' },
        }),
    );
    const client = new DaluxClient({ apiKey: 'k', fetchImpl });

    await expect(client.getBinary('/2.0/x/content', 10)).rejects.toThrow('exceeds');
    const ok = await client.getBinary('/2.0/x/content', 100);
    expect(ok.bytes.byteLength).toBe(64);
    expect(ok.contentType).toBe('application/pdf');
  });
});
