import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STREAM_INTERRUPTED, STREAM_KEY_REFUSED } from '../src/dalux/client.js';
import { FILE_DELETED_MESSAGE, FILE_LINK_REFUSED_MESSAGE, FILE_LINK_UNAVAILABLE_HOSTED_MESSAGE } from '../src/dalux/file-links.js';
import { createDaluxGateway, type FileLinkRequest } from '../src/gateway.js';
import { BASE, texts } from './helpers.js';

const originalEnv = { ...process.env };

beforeEach(() => {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('DALUX_')) delete process.env[name];
  }
});

afterEach(() => {
  process.env = { ...originalEnv };
});

const KEY = `filekey-${'q'.repeat(16)}`;
const PROJECT = '100000000000000001';
const OTHER = '100000000000000002';
const FILE = { projectId: PROJECT, fileAreaId: '42', fileId: '99' };
const META = `${BASE}/5.0/projects/${PROJECT}/file_areas/42/files/99`;

const LINK = { url: 'https://host.example/f/token', expiresAt: '2030-01-01T00:00:00.000Z' };

/** A body that sends the given chunks, one per read; `stall` keeps the last read open until aborted. */
function chunked(chunks: Uint8Array[], stall = false): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(chunks[i]!);
        i += 1;
        return;
      }
      if (stall) return new Promise<void>(() => undefined);
      controller.close();
    },
  });
}

interface Stand {
  metadata?: Record<string, unknown>;
  body?: () => ReadableStream<Uint8Array>;
  headers?: Record<string, string>;
}

function standIn(stand: Stand = {}) {
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    if (href === `${BASE}/5.0/projects/${PROJECT}`) {
      return Response.json({ data: { projectId: PROJECT, modules: [{ type: 'box', tier: 'pro' }] } });
    }
    if (href === META) {
      return Response.json({
        data: { fileId: '99', fileRevisionId: '7', fileName: 'Plan A.pdf', fileSize: 11, fileType: 'drawing', ...stand.metadata },
      });
    }
    if (href.startsWith(`${BASE}/2.0/projects/${PROJECT}/file_areas/42/files/99/revisions/`)) {
      const signal = init?.signal;
      const body = stand.body ? stand.body() : chunked([new TextEncoder().encode('hello world')]);
      signal?.addEventListener('abort', () => void body.cancel().catch(() => undefined));
      return new Response(body, { status: 200, headers: { 'content-type': 'application/pdf', ...stand.headers } });
    }
    return new Response(null, { status: 404 });
  });
}

async function readAll(body: ReadableStream<Uint8Array>): Promise<{ bytes: Uint8Array; error?: string }> {
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
    }
  } catch (error) {
    return { bytes: Buffer.concat(parts), error: (error as Error).message };
  }
  return { bytes: Buffer.concat(parts) };
}

describe('get_file_link', () => {
  it('is refused without a host hook', async () => {
    const gw = createDaluxGateway({ apiKey: KEY, baseUrl: BASE, fetchImpl: standIn() as unknown as typeof fetch, policy: {} });
    const result = await gw.callTool('get_file_link', FILE);
    expect(result.isError).toBe(true);
    expect(texts(result).join(' ')).toContain(FILE_LINK_UNAVAILABLE_HOSTED_MESSAGE);
  });

  it('asks the host for a link with ids only, the current revision by default', async () => {
    const asked: FileLinkRequest[] = [];
    const gw = createDaluxGateway({
      apiKey: KEY,
      baseUrl: BASE,
      fetchImpl: standIn() as unknown as typeof fetch,
      policy: {},
      fileLinks: async file => {
        asked.push(file);
        return LINK;
      },
    });
    const result = await gw.callTool('get_file_link', FILE);
    expect(result.isError).toBeUndefined();
    expect(asked).toEqual([{ ...FILE, fileRevisionId: '7' }]);
    expect(result.structuredContent).toMatchObject({ ...LINK, fileName: 'Plan A.pdf', fileSize: 11, fileRevisionId: '7' });
  });

  it('refuses a deleted file without asking the host', async () => {
    const hook = vi.fn(async () => LINK);
    const gw = createDaluxGateway({
      apiKey: KEY,
      baseUrl: BASE,
      fetchImpl: standIn({ metadata: { deleted: true } }) as unknown as typeof fetch,
      policy: {},
      fileLinks: hook,
    });
    const result = await gw.callTool('get_file_link', FILE);
    expect(result.isError).toBe(true);
    expect(texts(result).join(' ')).toContain(FILE_DELETED_MESSAGE);
    expect(hook).not.toHaveBeenCalled();
  });

  it('refuses a link that is not https', async () => {
    const gw = createDaluxGateway({
      apiKey: KEY,
      baseUrl: BASE,
      fetchImpl: standIn() as unknown as typeof fetch,
      policy: {},
      fileLinks: async () => ({ url: 'http://host.example/f', expiresAt: LINK.expiresAt }),
    });
    const result = await gw.callTool('get_file_link', FILE);
    expect(texts(result).join(' ')).toContain(FILE_LINK_REFUSED_MESSAGE);
  });
});

describe('openFile', () => {
  const request = { ...FILE, fileRevisionId: '7' };

  it('streams the bytes as they come, with the file name from Dalux', async () => {
    const fetchImpl = standIn({
      body: () => chunked([new TextEncoder().encode('first '), new TextEncoder().encode('second')]),
      headers: { 'content-length': '12' },
    });
    const gw = createDaluxGateway({ apiKey: KEY, baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch, policy: {} });
    const opened = await gw.openFile(request);
    expect(opened.ok ? 'ok' : JSON.stringify(opened.result)).toBe('ok');
    if (!opened.ok) return;
    expect(opened.fileName).toBe('Plan A.pdf');
    expect(opened.contentType).toBe('application/pdf');
    expect(opened.sizeBytes).toBe(12);
    const { bytes, error } = await readAll(opened.body);
    expect(error).toBeUndefined();
    expect(Buffer.from(bytes).toString()).toBe('first second');
  });

  it('stops on any 6-character piece of the key, also split across chunks, before any of it is passed on', async () => {
    const enc = (text: string) => new TextEncoder().encode(text);
    const half = KEY.length >> 1;
    const cases: Array<{ name: string; chunks: Uint8Array[]; piece: string }> = [
      { name: 'six characters', chunks: [enc(`start ${KEY.slice(3, 9)} end`)], piece: KEY.slice(3, 9) },
      { name: 'halves apart', chunks: [enc(`${KEY.slice(0, half)}\n${KEY.slice(half)}`)], piece: KEY.slice(0, 6) },
      { name: 'piece split 3+3', chunks: [enc(`${'b'.repeat(50)}${KEY.slice(5, 8)}`), enc(`${KEY.slice(8, 11)}${'c'.repeat(50)}`)], piece: KEY.slice(5, 8) },
      { name: 'piece split 5+1', chunks: [enc(`${'d'.repeat(50)}${KEY.slice(10, 15)}`), enc(`${KEY.slice(15, 16)}tail`)], piece: KEY.slice(10, 15) },
    ];
    for (const { name, chunks, piece } of cases) {
      const fetchImpl = standIn({ body: () => chunked(chunks) });
      const gw = createDaluxGateway({ apiKey: KEY, baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch, policy: {} });
      const opened = await gw.openFile(request);
      if (!opened.ok) throw new Error(`${name}: not opened`);
      const { bytes, error } = await readAll(opened.body);
      expect(error, name).toBe(STREAM_KEY_REFUSED);
      expect(Buffer.from(bytes).toString('latin1'), name).not.toContain(piece);
    }
  });

  it('passes on five characters of the key, which are not a piece of it', async () => {
    const text = `x ${KEY.slice(2, 7)} y`;
    const fetchImpl = standIn({ body: () => chunked([new TextEncoder().encode(text)]) });
    const gw = createDaluxGateway({ apiKey: KEY, baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch, policy: {} });
    const opened = await gw.openFile(request);
    if (!opened.ok) throw new Error('not opened');
    const { bytes, error } = await readAll(opened.body);
    expect(error).toBeUndefined();
    expect(Buffer.from(bytes).toString()).toBe(text);
  });

  it('keeps the streams of two companies apart when they are opened at the same time', async () => {
    const OTHER_KEY = `otherkey-${'z'.repeat(16)}`;
    const make = (key: string, text: string) => {
      const keys: Array<string | null> = [];
      const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
        keys.push(new Headers(init?.headers).get('x-api-key'));
        return standIn({
          body: () => chunked(text.split('|').map(part => new TextEncoder().encode(part)), false),
        })(url, init);
      });
      return { keys, gw: createDaluxGateway({ apiKey: key, baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch, policy: {} }) };
    };
    const a = make(KEY, 'alpha-1 |alpha-2 |alpha-3');
    const b = make(OTHER_KEY, 'beta-1 |beta-2 |beta-3');
    const [openedA, openedB] = await Promise.all([a.gw.openFile(request), b.gw.openFile(request)]);
    if (!openedA.ok || !openedB.ok) throw new Error('not opened');
    // Read the two streams interleaved, one chunk at a time.
    const readerA = openedA.body.getReader();
    const readerB = openedB.body.getReader();
    const partsA: Uint8Array[] = [];
    const partsB: Uint8Array[] = [];
    for (let doneA = false, doneB = false; !doneA || !doneB; ) {
      if (!doneA) {
        const next = await readerA.read();
        if (next.done) doneA = true;
        else partsA.push(next.value);
      }
      if (!doneB) {
        const next = await readerB.read();
        if (next.done) doneB = true;
        else partsB.push(next.value);
      }
    }
    expect(Buffer.concat(partsA).toString()).toBe('alpha-1 alpha-2 alpha-3');
    expect(Buffer.concat(partsB).toString()).toBe('beta-1 beta-2 beta-3');
    expect(new Set(a.keys)).toEqual(new Set([KEY]));
    expect(new Set(b.keys)).toEqual(new Set([OTHER_KEY]));
  });

  it('stops before passing on a key split across chunks', async () => {
    const half = KEY.length >> 1;
    const fetchImpl = standIn({
      body: () =>
        chunked([
          new TextEncoder().encode(`${'a'.repeat(100)}${KEY.slice(0, half)}`),
          new TextEncoder().encode(`${KEY.slice(half)}tail`),
        ]),
    });
    const gw = createDaluxGateway({ apiKey: KEY, baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch, policy: {} });
    const opened = await gw.openFile(request);
    if (!opened.ok) throw new Error('not opened');
    const { bytes, error } = await readAll(opened.body);
    expect(error).toBe(STREAM_KEY_REFUSED);
    expect(Buffer.from(bytes).toString('latin1')).not.toContain(KEY.slice(0, half));
  });

  it('fails a stream that stalls, with our own text', async () => {
    const fetchImpl = standIn({ body: () => chunked([new TextEncoder().encode('start')], true) });
    const gw = createDaluxGateway({
      apiKey: KEY,
      baseUrl: BASE,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      policy: {},
      timeoutMs: 50,
    });
    const opened = await gw.openFile(request);
    if (!opened.ok) throw new Error('not opened');
    const { error } = await readAll(opened.body);
    expect(error).toBe(STREAM_INTERRUPTED);
  });

  it('does not hold a concurrency slot while the body streams', async () => {
    const fetchImpl = standIn({ body: () => chunked([new TextEncoder().encode('x')], true) });
    const gw = createDaluxGateway({
      apiKey: KEY,
      baseUrl: BASE,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      policy: {},
      maxConcurrency: 1,
    });
    const opened = await gw.openFile(request);
    if (!opened.ok) throw new Error('not opened');
    const other = await gw.callTool('list_files', FILE);
    expect(other.isError).toBeUndefined();
    await opened.body.cancel();
  });

  it('holds to the instance policy: the project and the tool', async () => {
    const fetchImpl = standIn();
    const held = createDaluxGateway({
      apiKey: KEY,
      baseUrl: BASE,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      policy: { allowedProjectIds: [OTHER] },
    });
    const outside = await held.openFile(request);
    expect(outside.ok).toBe(false);

    const off = createDaluxGateway({
      apiKey: KEY,
      baseUrl: BASE,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      policy: { disabledTools: ['get_file_link'] },
    });
    const disabled = await off.openFile(request);
    expect(disabled.ok).toBe(false);
    expect(fetchImpl.mock.calls.some(([url]) => String(url).includes('/content'))).toBe(false);
  });

  it('refuses a project number or name, a missing revision and a deleted file', async () => {
    const gw = createDaluxGateway({ apiKey: KEY, baseUrl: BASE, fetchImpl: standIn() as unknown as typeof fetch, policy: {} });
    expect((await gw.openFile({ ...request, projectId: 'S-1234' })).ok).toBe(false);
    expect((await gw.openFile({ ...FILE } as never)).ok).toBe(false);

    const deleted = createDaluxGateway({
      apiKey: KEY,
      baseUrl: BASE,
      fetchImpl: standIn({ metadata: { deleted: true } }) as unknown as typeof fetch,
      policy: {},
    });
    const result = await deleted.openFile(request);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(texts(result.result).join(' ')).toContain(FILE_DELETED_MESSAGE);
  });

  it('gives a Dalux error as a redacted error result with its status', async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const href = String(url);
      if (href === `${BASE}/5.0/projects/${PROJECT}`) return Response.json({ data: { modules: [{ type: 'box', tier: 'pro' }] } });
      if (href === META) return Response.json({ data: { fileRevisionId: '7', fileName: 'x.pdf' } });
      return new Response(`denied ${KEY}`, { status: 403 });
    });
    const gw = createDaluxGateway({ apiKey: KEY, baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch, policy: {} });
    const result = await gw.openFile(request);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.result.failure?.httpStatus).toBe(403);
    expect(JSON.stringify(result.result)).not.toContain(KEY);
  });

  it('gives a safe download name', async () => {
    const gw = createDaluxGateway({
      apiKey: KEY,
      baseUrl: BASE,
      fetchImpl: standIn({ metadata: { fileName: '../a\nb.pdf' } }) as unknown as typeof fetch,
      policy: {},
    });
    const opened = await gw.openFile(request);
    if (!opened.ok) throw new Error('not opened');
    expect(opened.fileName).toBe('.._a_b.pdf');
    await opened.body.cancel();
  });
});
