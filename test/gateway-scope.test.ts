import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDaluxGateway } from '../src/gateway.js';
import { BASE, stubFetch, texts } from './helpers.js';

// Every gateway call runs in a call scope of its own: its policy (or the environment), its sink and its
// redactor, also when it is made from inside another instance's call, and also across await.

const originalEnv = { ...process.env };

beforeEach(() => {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('DALUX_')) {
      delete process.env[name];
    }
  }
});

afterEach(() => {
  process.env = { ...originalEnv };
});

type AuditRecord = Record<string, unknown>;

const KEY_A = `tenant-a-${'a'.repeat(12)}`;
const KEY_B = `tenant-b-${'b'.repeat(12)}`;
// Longer than every cut the audit makes (64 for field names, 100 for tool names, 200 for reasons), so a
// key that was cut before it was redacted would show.
const LONG_KEY = `long-${'k'.repeat(250)}`;

const PROJECT = '900000000000000001';
const OTHER_PROJECT = '900000000000000002';
const COMPANIES = `${BASE}/3.1/projects/${PROJECT}/companies`;
const WRITE = { scope: 'project', action: 'create', projectId: PROJECT, body: { name: 'Example ApS', vatNumber: '12345678' } };

function routes() {
  return stubFetch({
    [`${BASE}/3.4/projects/${PROJECT}/tasks/t1`]: { body: { data: { taskId: 't1' } } },
    [`${BASE}/3.4/projects/${OTHER_PROJECT}/tasks/t1`]: { body: { data: { taskId: 't1' } } },
    [COMPANIES]: { body: { data: { companyId: 'c1' } } },
  });
}

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

/** A fetch whose answers wait until `release` is called, recording the key each request carried. */
function heldFetch() {
  let release!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  let signalStarted!: () => void;
  /** Resolves when the first request has reached the stand-in and is waiting. */
  const started = new Promise<void>(resolve => {
    signalStarted = resolve;
  });
  const keys: string[] = [];
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    keys.push(String((init?.headers as Record<string, string> | undefined)?.['X-API-KEY'] ?? ''));
    signalStarted();
    await gate;
    return json({ data: { taskId: 't1' } });
  }) as unknown as typeof fetch;
  return { fetchImpl, release, started, keys };
}

const posts = (fetchImpl: ReturnType<typeof stubFetch>) =>
  fetchImpl.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST');

describe('audit records', () => {
  it('are never written with a key the redactor cannot protect: a short key is refused', () => {
    for (const apiKey of ['abc123', 'k', '1234567']) {
      expect(() => createDaluxGateway({ apiKey, baseUrl: BASE, policy: {} }), apiKey).toThrow(/at least 8 characters/);
    }
    expect(() => createDaluxGateway({ apiKey: '12345678', baseUrl: BASE, policy: {} })).not.toThrow();
  });

  it('keep the instance key out, refusals, input and metadata included', async () => {
    const records: AuditRecord[] = [];
    const gw = createDaluxGateway({
      apiKey: LONG_KEY,
      baseUrl: BASE,
      fetchImpl: routes() as unknown as typeof fetch,
      policy: { audit: record => void records.push(record) },
    });
    const metadata = { caller: `person ${LONG_KEY}`, requestId: LONG_KEY };
    await gw.callTool(LONG_KEY, {}, metadata);
    await gw.callTool(`get_${LONG_KEY}`, { projectId: PROJECT, taskId: 't1' }, metadata);
    await gw.callTool('get_task', { [LONG_KEY]: 'x', projectId: PROJECT, taskId: 't1' }, metadata);
    await gw.callTool('get_task', { projectId: PROJECT, taskId: LONG_KEY }, metadata);
    await gw.callTool('get_task', { projectId: LONG_KEY, taskId: 't1' }, metadata);
    await gw.callTool('change_company', { ...WRITE, body: { name: LONG_KEY } }, metadata);

    expect(records.length).toBeGreaterThanOrEqual(6);
    const text = JSON.stringify(records);
    expect(text).not.toContain(LONG_KEY);
    // Not even a part of it.
    expect(text).not.toContain('k'.repeat(40));
    expect(text).toContain('‹redacted›');
  });
});

describe('call scopes', () => {
  it('isolate two allowed calls with different keys, allowlists and sinks across await', async () => {
    const held = heldFetch();
    const sinkA: AuditRecord[] = [];
    const sinkB: AuditRecord[] = [];
    const fetchB = routes();
    const a = createDaluxGateway({
      apiKey: KEY_A,
      baseUrl: BASE,
      fetchImpl: held.fetchImpl,
      policy: { allowedProjectIds: [PROJECT], audit: r => void sinkA.push(r) },
    });
    const b = createDaluxGateway({
      apiKey: KEY_B,
      baseUrl: BASE,
      fetchImpl: fetchB as unknown as typeof fetch,
      policy: { allowedProjectIds: [OTHER_PROJECT, PROJECT], enableWrites: true, audit: r => void sinkB.push(r) },
    });

    // A starts and waits inside its request; B reads another project and writes meanwhile; then A resumes.
    const pendingA = a.callTool('get_task', { projectId: PROJECT, taskId: 't1' }, { requestId: 'a' });
    await held.started;
    expect(held.keys).toEqual([KEY_A]);
    expect((await b.callTool('get_task', { projectId: OTHER_PROJECT, taskId: 't1' }, { requestId: 'b1' })).isError).toBeUndefined();
    expect((await b.callTool('change_company', WRITE, { requestId: 'b2' })).isError).toBeFalsy();
    held.release();
    expect((await pendingA).isError).toBeUndefined();
    // After resuming, A still has its own allowlist and no writes, not B's.
    const outside = await a.callTool('get_task', { projectId: OTHER_PROJECT, taskId: 't1' }, { requestId: 'a2' });
    expect(outside.isError).toBe(true);
    expect((await a.callTool('change_company', WRITE, { requestId: 'a3' })).isError).toBe(true);

    expect(held.keys).toEqual([KEY_A]);
    expect(sinkA.filter(r => r.requestId === 'a').map(r => r.action)).toEqual(['start', 'finish']);
    expect(new Set(sinkA.map(r => r.requestId))).toEqual(new Set(['a', 'a2', 'a3']));
    expect(new Set(sinkB.map(r => r.requestId))).toEqual(new Set(['b1', 'b2']));
    expect(posts(fetchB)).toHaveLength(1);
  });

  it('do not let a call from inside another instance inherit its policy or sink', async () => {
    // A allows writes and audits to its sink. From inside A's sink, B (no host policy; the environment
    // allows no writes) tries a write: refused, nothing sent, and nothing of B's in A's sink.
    const sinkA: AuditRecord[] = [];
    const fetchB = routes();
    const b = createDaluxGateway({ apiKey: KEY_B, baseUrl: BASE, fetchImpl: fetchB as unknown as typeof fetch });
    const nested: Array<ReturnType<typeof b.callTool>> = [];
    const a = createDaluxGateway({
      apiKey: KEY_A,
      baseUrl: BASE,
      fetchImpl: routes() as unknown as typeof fetch,
      policy: {
        enableWrites: true,
        audit: record => {
          sinkA.push(record);
          if (record.action === 'start' && nested.length === 0) {
            nested.push(b.callTool('change_company', WRITE, { requestId: 'b' }));
          }
        },
      },
    });
    expect((await a.callTool('change_company', WRITE, { requestId: 'a' })).isError).toBeFalsy();
    const fromInside = await nested[0]!;
    expect(fromInside.isError).toBe(true);
    expect(texts(fromInside).join(' ')).toMatch(/DALUX_ENABLE_WRITES/);
    expect(fetchB).not.toHaveBeenCalled();
    expect(sinkA.every(r => r.requestId === 'a')).toBe(true);
  });

  it('do not let an instance with a policy, called from inside one without, use the environment', async () => {
    // A has no host policy and the environment allows writes. From inside A's upstream request, B (host
    // policy without writes) tries a write: refused. After B returns, A's own write still goes through.
    process.env.DALUX_ENABLE_WRITES = 'true';
    const fetchB = routes();
    const b = createDaluxGateway({ apiKey: KEY_B, baseUrl: BASE, fetchImpl: fetchB as unknown as typeof fetch, policy: {} });
    let fromInside: { isError?: boolean } | undefined;
    const fetchA = (async () => {
      fromInside ??= await b.callTool('change_company', WRITE);
      return json({ data: { companyId: 'c1' } });
    }) as unknown as typeof fetch;
    const a = createDaluxGateway({ apiKey: KEY_A, baseUrl: BASE, fetchImpl: fetchA });
    expect((await a.callTool('change_company', WRITE)).isError).toBeFalsy();
    expect(fromInside?.isError).toBe(true);
    expect(fetchB).not.toHaveBeenCalled();
  });

  it('never send a write upstream when the start record is refused', async () => {
    const fetchImpl = routes();
    const gw = createDaluxGateway({
      apiKey: KEY_A,
      baseUrl: BASE,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      policy: {
        enableWrites: true,
        audit: record => {
          if (record.action === 'start') throw new Error('sink down');
        },
      },
    });
    expect((await gw.callTool('get_task', { projectId: PROJECT, taskId: 't1' })).isError).toBeUndefined();
    const write = await gw.callTool('change_company', WRITE);
    expect(write.isError).toBe(true);
    expect(posts(fetchImpl)).toEqual([]);
  });

  it('name the host, not an environment variable, when a host policy refuses', async () => {
    const gw = createDaluxGateway({
      apiKey: KEY_A,
      baseUrl: BASE,
      fetchImpl: routes() as unknown as typeof fetch,
      policy: { disabledTools: ['list_forms'], allowedProjectIds: [PROJECT] },
    });
    const refusals = [
      await gw.callTool('list_forms', { projectId: PROJECT }),
      await gw.callTool('get_task', { projectId: OTHER_PROJECT, taskId: 't1' }),
      await gw.callTool('change_company', WRITE),
    ].map(result => texts(result).join(' '));
    for (const text of refusals) {
      expect(text).not.toMatch(/DALUX_/);
      expect(text).toMatch(/host/);
    }
  });
});
