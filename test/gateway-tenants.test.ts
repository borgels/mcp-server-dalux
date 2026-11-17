import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DaluxClient } from '../src/dalux/client.js';
import { createDaluxGateway, daluxGatewayTools, daluxToolCatalog } from '../src/gateway.js';
import { BASE, auditLines, connect, stubFetch, texts } from './helpers.js';

const originalEnv = { ...process.env };
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dalux-tenants-'));
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('DALUX_')) {
      delete process.env[name];
    }
  }
});

afterEach(() => {
  process.env = { ...originalEnv };
  rmSync(dir, { recursive: true, force: true });
});

/** Placeholder credentials, built at runtime: long enough to be redacted by value. */
const fakeKey = (label: string) => `${label}-${'x'.repeat(12)}`;
// Keys with no piece of six characters in common: the redactor also removes any such piece of its own key.
const ALPHA = 'alpha-0123456789-kq';
const BRAVO = 'bravo-zyxwvutsrq-MP';
const FROM_ENV = 'envkey-ABCDEFGHIJ-77';

/** Dalux stand-in that answers every request with an error body echoing `echo`. */
function echoingFetch(echo: string) {
  return vi.fn(
    async () =>
      new Response(`upstream rejected credentials ${echo}`, { status: 400, headers: { 'content-type': 'text/plain' } }),
  ) as unknown as typeof fetch;
}

function headersOf(init?: RequestInit): Record<string, string> {
  return (init?.headers ?? {}) as Record<string, string>;
}

describe('explicit gateway credentials', () => {
  it('requires apiKey and baseUrl and ignores the environment', () => {
    process.env.DALUX_API_KEY = FROM_ENV;
    process.env.DALUX_BASE_URL = BASE;

    expect(() => createDaluxGateway({ baseUrl: BASE } as never)).toThrow(/requires options\.apiKey/);
    expect(() => createDaluxGateway({ apiKey: ALPHA } as never)).toThrow(/requires options\.baseUrl/);
    expect(() => createDaluxGateway({ apiKey: '  ', baseUrl: BASE })).toThrow(/requires options\.apiKey/);
    expect(() => createDaluxGateway(undefined as never)).toThrow(/requires options\.apiKey/);
  });

  it('never reads credential variables from process.env, even when they are set', async () => {
    const reads = new Set<string>();
    const env = { ...process.env, DALUX_API_KEY: FROM_ENV, DALUX_BASE_URL: BASE };
    process.env = new Proxy(env, {
      get(target, property, receiver) {
        if (typeof property === 'string') {
          reads.add(property);
        }
        return Reflect.get(target, property, receiver);
      },
    });

    expect(() => createDaluxGateway({ baseUrl: BASE } as never)).toThrow(/requires options\.apiKey/);

    const fetchImpl = stubFetch({ [`${BASE}/3.4/projects/p1/tasks/t1`]: { body: { data: { taskId: 't1' } } } });
    const gw = createDaluxGateway({ apiKey: ALPHA, baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await gw.callTool('get_task', { projectId: 'p1', taskId: 't1' });
    expect(result.isError).toBeUndefined();
    expect(headersOf(fetchImpl.mock.calls[0]?.[1])['X-API-KEY']).toBe(ALPHA);

    expect(reads.has('DALUX_API_KEY')).toBe(false);
    expect(reads.has('DALUX_BASE_URL')).toBe(false);
  });

  it('still reads credentials from the environment in the standalone client', async () => {
    process.env.DALUX_API_KEY = FROM_ENV;
    process.env.DALUX_BASE_URL = 'https://node1.field.dalux.com/service/api';
    const fetchImpl = vi.fn(async () => Response.json({})) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
    await new DaluxClient({ fetchImpl }).get('/5.1/projects');
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe('https://node1.field.dalux.com/service/api/5.1/projects');
    expect(headersOf(fetchImpl.mock.calls[0]?.[1] as RequestInit)['X-API-KEY']).toBe(FROM_ENV);
  });
});

describe('per-instance redaction', () => {
  it('redacts each instance’s own key in its tool results', async () => {
    const a = createDaluxGateway({ apiKey: ALPHA, baseUrl: BASE, fetchImpl: echoingFetch(ALPHA) });
    const b = createDaluxGateway({ apiKey: BRAVO, baseUrl: BASE, fetchImpl: echoingFetch(BRAVO) });

    const resultA = texts(await a.callTool('get_task', { projectId: 'p1', taskId: 't1' })).join(' ');
    const resultB = texts(await b.callTool('get_task', { projectId: 'p1', taskId: 't1' })).join(' ');
    // The echoing error body is never read into the result; the key is not there in any form.
    expect(resultA).not.toContain(ALPHA);
    expect(resultB).not.toContain(BRAVO);
  });

  it('keeps redactors separate: an instance holds only its own secrets', () => {
    const a = new DaluxClient({ apiKey: ALPHA, baseUrl: BASE, credentialEnv: {} });
    const b = new DaluxClient({ apiKey: BRAVO, baseUrl: BASE, credentialEnv: {} });
    expect(a.redactor.hasSecret(ALPHA)).toBe(true);
    expect(a.redactor.hasSecret(BRAVO)).toBe(false);
    expect(b.redactor.hasSecret(BRAVO)).toBe(true);
    expect(b.redactor.hasSecret(ALPHA)).toBe(false);
    // B neither knows nor needs A's key: its text is only redacted for its own.
    expect(b.redactor.redact(`a=${ALPHA} b ${BRAVO}`)).toBe(`a=${ALPHA} b ‹redacted›`);
  });

  it('does not accumulate keys of earlier instances', () => {
    for (let index = 0; index < 200; index += 1) {
      createDaluxGateway({ apiKey: `fleet-fleet-fleet-${index}`, baseUrl: BASE });
    }
    const fresh = new DaluxClient({ apiKey: ALPHA, baseUrl: BASE, credentialEnv: {} });
    expect(fresh.redactor.redact('fleet-fleet-fleet-7')).toBe('fleet-fleet-fleet-7');
  });

  it('redacts audit records with the key of the instance that ran the call', async () => {
    process.env.DALUX_AUDIT_LOG = join(dir, 'audit.jsonl');
    const failing = (key: string) =>
      vi.fn(async () => {
        throw new TypeError(`connection refused while sending ${key}`);
      }) as unknown as typeof fetch;
    const a = createDaluxGateway({ apiKey: ALPHA, baseUrl: BASE, fetchImpl: failing(ALPHA), maxAttempts: 1 });
    const b = createDaluxGateway({ apiKey: BRAVO, baseUrl: BASE, fetchImpl: failing(BRAVO), maxAttempts: 1 });
    await a.callTool('get_task', { projectId: 'p1', taskId: 't1' }, { requestId: 'a' });
    await b.callTool('get_task', { projectId: 'p1', taskId: 't1' }, { requestId: 'b' });

    const errors = auditLines(process.env.DALUX_AUDIT_LOG).filter(line => line.action === 'error');
    expect(errors.map(line => line.requestId)).toEqual(['a', 'b']);
    const log = JSON.stringify(errors);
    expect(log).not.toContain(ALPHA);
    expect(log).not.toContain(BRAVO);
  });

  it('lets a dropped instance and its key be garbage collected', async () => {
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as () => void;
    let gateway: ReturnType<typeof createDaluxGateway> | undefined = createDaluxGateway({
      apiKey: fakeKey('collectable'),
      baseUrl: BASE,
    });
    const ref = new WeakRef(gateway);
    gateway = undefined;
    for (let attempt = 0; attempt < 10 && ref.deref(); attempt += 1) {
      await new Promise(resolve => setImmediate(resolve));
      gc();
    }
    expect(ref.deref()).toBeUndefined();
  });
});

type Sample = Record<string, unknown>;

const area = { projectId: 'p1', fileAreaId: 'a1' };
/** Sample inputs per tool, covering each branch that calls a different endpoint. */
const SAMPLES: Record<string, Sample[]> = {
  search_capabilities: [{ query: 'tasks' }],
  list_projects: [{}, { includeTemplates: true }],
  get_project: [{ projectId: 'p1', includeMetadata: true }],
  list_project_users: [{ projectId: 'p1' }, { projectId: 'p1', userId: 'u1' }],
  list_tasks: [{ projectId: 'p1' }],
  get_task: [{ projectId: 'p1', taskId: 't1' }],
  get_task_changes: [{ projectId: 'p1' }],
  list_task_attachments: [{ projectId: 'p1' }],
  list_forms: [{ projectId: 'p1' }],
  get_form: [{ projectId: 'p1', formId: 'f1' }],
  list_form_attachments: [{ projectId: 'p1' }],
  list_quality_plans: ['inspection', 'test'].flatMap(kind =>
    ['plans', 'items', 'itemZones', 'registrations'].map(part => ({ projectId: 'p1', kind, part })),
  ),
  export_quality_plans: [{ projectId: 'p1' }, { projectId: 'p1', kind: 'test', includePhotos: false }],
  list_work_packages: [{ projectId: 'p1' }],
  list_file_areas: [{ projectId: 'p1' }, area],
  list_folders: [area, { ...area, folderId: 'd1' }],
  list_files: [area, { ...area, fileId: 'x1' }],
  list_version_sets: [
    { projectId: 'p1' },
    area,
    { projectId: 'p1', versionSetId: 'v1' },
    { projectId: 'p1', versionSetId: 'v1', includeFiles: true },
  ],
  download_file: [{ ...area, fileId: 'x1', fileRevisionId: 'r1' }],
  list_companies: [
    { projectId: 'p1' },
    { projectId: 'p1', companyId: 'c1' },
    { scope: 'catalog' },
    { scope: 'catalog', companyId: 'c1' },
  ],
  list_property_mappings: [
    { scope: 'folder', ...area, folderId: 'd1' },
    { scope: 'file', ...area, fileId: 'x1' },
    { scope: 'folder', ...area, key: 'k1' },
    { scope: 'project' },
    { scope: 'project', key: 'k1' },
    { scope: 'project', projectId: 'p1' },
    { scope: 'project', projectId: 'p1', key: 'k1' },
    { scope: 'companyCatalog' },
    { scope: 'companyCatalog', key: 'k1' },
    { scope: 'companyCatalog', companyId: 'c1' },
    { scope: 'companyCatalog', companyId: 'c1', key: 'k1' },
  ],
  upload_file: [{ ...area, fileName: 'a.txt', contentBase64: 'aGVsbG8=', folderId: 'd1' }],
  change_company: [
    { scope: 'project', action: 'create', projectId: 'p1', body: { name: 'Example ApS' } },
    { scope: 'project', action: 'update', projectId: 'p1', companyId: 'c1', body: { name: 'Example ApS' } },
    { scope: 'catalog', action: 'create', body: { name: 'Example ApS' } },
    { scope: 'catalog', action: 'update', companyId: 'c1', body: { name: 'Example ApS' } },
  ],
  change_project: [
    { action: 'create', adminEmail: 'admin@example.test', body: { projectName: 'New project' } },
    { action: 'update', projectId: 'p1', patch: { projectName: 'Renamed' } },
  ],
};

/** Generic Dalux stand-in: Box Pro project, upload slot, text file content, empty lists. */
function daluxStandIn() {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if ((init?.method ?? 'GET') === 'GET' && path.endsWith('/content')) {
      return new Response('file text', { headers: { 'content-type': 'text/plain' } });
    }
    if (path.endsWith('/upload')) {
      return Response.json({ data: { uploadGuid: 'g1' } });
    }
    if (path.endsWith('/5.1/projects')) {
      return Response.json({ items: [{ data: { projectId: 'p1' } }], metadata: {} });
    }
    if (path.endsWith('/5.0/projects/p1')) {
      return Response.json({ data: { projectId: 'p1', modules: [{ type: 'box', tier: 'pro' }] } });
    }
    return Response.json({ items: [], metadata: {} });
  });
}

function templateRegex(path: string): RegExp {
  const pattern = path
    .split(/\{\w+\}/)
    .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]+');
  return new RegExp(`^${pattern}$`);
}

describe('tool catalog', () => {
  it('lists every registered tool, matching the gateway definitions', async () => {
    expect(daluxToolCatalog.map(entry => entry.name)).toEqual(daluxGatewayTools.map(tool => tool.name));
    for (const entry of daluxToolCatalog) {
      const { upstream, broad, ...definition } = entry;
      expect(broad, entry.name).toBe(false);
      expect(definition).toEqual(daluxGatewayTools.find(tool => tool.name === entry.name));
      for (const operation of upstream) {
        if (operation.access === 'read') {
          expect(operation.method).toBe('GET');
        }
        if (entry.riskLevel === 'read') {
          expect(operation.access, `${entry.name} ${operation.path}`).toBe('read');
        }
      }
      if (entry.riskLevel === 'write') {
        expect(upstream.some(operation => operation.access === 'write'), entry.name).toBe(true);
      }
    }

    const { mcpClient } = await connect();
    const { tools } = await mcpClient.listTools();
    expect(tools.map(tool => tool.name).sort()).toEqual(daluxToolCatalog.map(entry => `dalux_${entry.name}`).sort());
    for (const tool of tools) {
      const entry = daluxToolCatalog.find(e => `dalux_${e.name}` === tool.name)!;
      expect(entry.title).toBe(tool.title);
      expect(entry.description).toBe(tool.description);
      expect(Object.keys(entry.inputSchema.properties as object).sort()).toEqual(
        Object.keys(tool.inputSchema.properties ?? {}).sort(),
      );
    }
  });

  it('is deeply frozen', () => {
    expect(Object.isFrozen(daluxToolCatalog)).toBe(true);
    const visit = (value: unknown) => {
      if (typeof value === 'object' && value !== null) {
        expect(Object.isFrozen(value)).toBe(true);
        Object.values(value).forEach(visit);
      }
    };
    visit(daluxToolCatalog);
    expect(() => {
      (daluxToolCatalog[0] as { name: string }).name = 'changed';
    }).toThrow(TypeError);
  });

  it('declares every Dalux API request each tool makes', async () => {
    process.env.DALUX_ENABLE_WRITES = 'true';
    process.env.DALUX_EXPORT_DIR = dir;
    process.env.DALUX_EXPORT_DELIVERY = 'file';
    process.env.DALUX_EXPORT_MAX_TOTAL_BYTES = String(16 * 1024 * 1024);
    const basePath = new URL(BASE).pathname;
    expect(Object.keys(SAMPLES).sort()).toEqual(daluxToolCatalog.map(entry => entry.name).sort());

    for (const entry of daluxToolCatalog) {
      const declared = entry.upstream.map(operation => ({
        method: operation.method,
        pattern: templateRegex(operation.path),
      }));
      for (const input of SAMPLES[entry.name]!) {
        const fetchImpl = daluxStandIn();
        const gw = createDaluxGateway({ apiKey: ALPHA, baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch });
        const result = await gw.callTool(entry.name, input as never);
        expect(result.isError, `${entry.name} ${JSON.stringify(input)}: ${texts(result).join(' ')}`).toBeUndefined();

        const made = (fetchImpl.mock.calls as unknown as Array<[string, RequestInit | undefined]>).map(
          ([url, init]) => ({
            method: init?.method ?? 'GET',
            path: new URL(url).pathname.slice(basePath.length),
          }),
        );
        if (entry.upstream.length > 0) {
          expect(made.length, `${entry.name} made no request`).toBeGreaterThan(0);
        }
        for (const request of made) {
          const ok = declared.some(op => op.method === request.method && op.pattern.test(request.path));
          expect(ok, `${entry.name} made undeclared ${request.method} ${request.path}`).toBe(true);
        }
      }
    }
  });
});
