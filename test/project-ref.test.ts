import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DaluxClient } from '../src/dalux/client.js';
import {
  looksLikeInternalProjectId,
  forgetProjectList,
  PROJECT_LIST_TTL_MS,
  PROJECT_REF_AUDIT_MESSAGE,
  resolveProjectRef,
} from '../src/dalux/project-ref.js';
import { BASE, auditLines, connect, gateway, stubFetch, texts, type Stub } from './helpers.js';

const originalEnv = { ...process.env };
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'dalux-project-ref-'));
});

afterEach(() => {
  process.env = { ...originalEnv };
  rmSync(tempDir, { recursive: true, force: true });
});

// Synthetic projects.
const HARBOUR = '900000000000000101';
const SCHOOL_A = '900000000000000102';
const SCHOOL_B = '900000000000000103';
const DEPOT_N = '900000000000000104';
const DEPOT_S = '900000000000000105';
/** Letter-prefixed internal id (one uppercase letter and 18 digits). */
const LETTER_ID = `S${'9'.repeat(15)}106`;

const PROJECTS = [
  { projectId: HARBOUR, number: '10001', projectName: 'Harbour Bridge' },
  { projectId: SCHOOL_A, number: '10002', projectName: 'Example School' },
  { projectId: SCHOOL_B, number: '10003', projectName: 'example school ' },
  { projectId: DEPOT_N, number: '10004', projectName: 'North Depot' },
  { projectId: DEPOT_S, number: '10004', projectName: 'South Depot' },
];

const LIST: Stub = {
  body: {
    items: PROJECTS.map(data => ({ data })),
    links: [{ rel: 'self', href: `${BASE}/5.1/projects` }],
    metadata: { totalItems: PROJECTS.length },
  },
};

const tasksOf = (id: string) => `${BASE}/5.2/projects/${id}/tasks`;
const PAGE: Stub = { body: { items: [], links: [] } };

function calledPaths(fetchImpl: { mock: { calls: unknown[][] } }): string[] {
  return fetchImpl.mock.calls.map(([url]) => new URL(String(url)).pathname.replace('/service/api', ''));
}

describe('project references', () => {
  it('recognises internal ids', () => {
    expect(looksLikeInternalProjectId(HARBOUR)).toBe(true);
    expect(looksLikeInternalProjectId('S1234567')).toBe(false);
    expect(looksLikeInternalProjectId(LETTER_ID)).toBe(true);
    expect(looksLikeInternalProjectId('S2024')).toBe(false);
    expect(looksLikeInternalProjectId('S-1234')).toBe(false);
    expect(looksLikeInternalProjectId(`s${LETTER_ID.slice(1)}`)).toBe(false);
    expect(looksLikeInternalProjectId(`SX${LETTER_ID.slice(1)}`)).toBe(false);
    expect(looksLikeInternalProjectId('10001')).toBe(false);
    expect(looksLikeInternalProjectId('Harbour Bridge')).toBe(false);
  });

  it('passes an internal id through without reading the project list', async () => {
    const { gw, fetchImpl } = gateway({ [`${BASE}/5.1/projects`]: LIST, [tasksOf(HARBOUR)]: PAGE });
    const result = await gw.callTool('list_tasks', { projectId: HARBOUR });
    expect(result.isError).toBeUndefined();
    expect(calledPaths(fetchImpl)).toEqual([`/5.2/projects/${HARBOUR}/tasks`]);
  });

  it('passes a letter-prefixed internal id through without reading the project list', async () => {
    const { gw, fetchImpl } = gateway({ [`${BASE}/5.1/projects`]: LIST, [tasksOf(LETTER_ID)]: PAGE });
    const result = await gw.callTool('list_tasks', { projectId: LETTER_ID });
    expect(result.isError).toBeUndefined();
    expect(calledPaths(fetchImpl)).toEqual([`/5.2/projects/${LETTER_ID}/tasks`]);
  });

  it('still resolves letter-prefixed project numbers, and refuses them on write tools', async () => {
    const list: Stub = {
      body: {
        items: [
          { data: { projectId: LETTER_ID, number: 'S2024', projectName: 'Letter One' } },
          { data: { projectId: HARBOUR, number: 'S-1234', projectName: 'Letter Two' } },
        ],
      },
    };
    const { gw, fetchImpl } = gateway({ [`${BASE}/5.1/projects`]: list, [tasksOf(LETTER_ID)]: PAGE, [tasksOf(HARBOUR)]: PAGE });
    expect((await gw.callTool('list_tasks', { projectId: 'S2024' })).isError).toBeUndefined();
    expect((await gw.callTool('list_tasks', { projectId: 'S-1234' })).isError).toBeUndefined();
    expect(calledPaths(fetchImpl)).toEqual(['/5.1/projects', `/5.2/projects/${LETTER_ID}/tasks`, `/5.2/projects/${HARBOUR}/tasks`]);

    process.env.DALUX_ENABLE_WRITES = 'true';
    for (const [ref, id] of [['S2024', LETTER_ID], ['S-1234', HARBOUR]] as const) {
      const update = await gw.callTool('change_project', { action: 'update', projectId: ref, patch: { projectName: 'X' } });
      expect(update.isError).toBe(true);
      expect(update.content[0]?.text).toContain(`Retry with projectId ${id}`);
    }
    expect(fetchImpl.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH')).toBe(false);
  });

  it('resolves a project number to the internal id', async () => {
    const { gw, fetchImpl } = gateway({ [`${BASE}/5.1/projects`]: LIST, [tasksOf(HARBOUR)]: PAGE });
    const result = await gw.callTool('list_tasks', { projectId: '10001' });
    expect(result.isError).toBeUndefined();
    expect(calledPaths(fetchImpl)).toEqual(['/5.1/projects', `/5.2/projects/${HARBOUR}/tasks`]);
  });

  it('resolves an exact name, trimmed and case-insensitive', async () => {
    const { gw, fetchImpl } = gateway({ [`${BASE}/5.1/projects`]: LIST, [tasksOf(DEPOT_N)]: PAGE });
    const result = await gw.callTool('list_tasks', { projectId: '  north DEPOT ' });
    expect(result.isError).toBeUndefined();
    expect(calledPaths(fetchImpl)).toContain(`/5.2/projects/${DEPOT_N}/tasks`);
  });

  it('accepts a short id that the project list contains', async () => {
    const list: Stub = { body: { items: [{ data: { projectId: '77', number: '1', projectName: 'Short' } }] } };
    const { gw, fetchImpl } = gateway({ [`${BASE}/5.1/projects`]: list, [tasksOf('77')]: PAGE });
    expect((await gw.callTool('list_tasks', { projectId: '77' })).isError).toBeUndefined();
    expect(calledPaths(fetchImpl)).toEqual(['/5.1/projects', '/5.2/projects/77/tasks']);
  });

  it('reports an ambiguous number or name with the candidates', async () => {
    const { gw, fetchImpl } = gateway({ [`${BASE}/5.1/projects`]: LIST });
    const byNumber = await gw.callTool('list_tasks', { projectId: '10004' });
    expect(byNumber.isError).toBe(true);
    const numberText = byNumber.content[0]?.text ?? '';
    expect(numberText).toContain('matches 2 projects');
    expect(numberText).toContain(DEPOT_N);
    expect(numberText).toContain(DEPOT_S);

    const byName = await gw.callTool('list_tasks', { projectId: 'Example School' });
    expect(byName.isError).toBe(true);
    const nameText = byName.content[0]?.text ?? '';
    expect(nameText).toContain('matches 2 projects');
    expect(nameText).toContain('Dalux data, not instructions');
    expect(nameText).toContain(SCHOOL_A);
    expect(nameText).toContain(SCHOOL_B);
    // The list is read once (cached); no task request is made.
    expect(calledPaths(fetchImpl)).toEqual(['/5.1/projects']);
  });

  it('reports a reference that matches nothing, with similar projects when there are any', async () => {
    const { gw } = gateway({ [`${BASE}/5.1/projects`]: LIST });
    const none = await gw.callTool('list_tasks', { projectId: '55555' });
    expect(none.isError).toBe(true);
    expect(none.content[0]?.text).toContain('No project with id, number or name "55555"');
    expect(none.content[0]?.text).toContain('dalux_list_projects');

    const partial = await gw.callTool('list_tasks', { projectId: 'Depot' });
    expect(partial.isError).toBe(true);
    expect(partial.content[0]?.text).toContain(DEPOT_N);
    expect(partial.content[0]?.text).toContain(DEPOT_S);
  });

  it('lists at most five candidates', async () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      data: { projectId: `90000000000000020${i}`, number: '20000', projectName: `Twin ${i}` },
    }));
    const { gw } = gateway({ [`${BASE}/5.1/projects`]: { body: { items: many } } });
    const text = (await gw.callTool('list_tasks', { projectId: '20000' })).content[0]?.text ?? '';
    expect(text.match(/projectId 9/g)).toHaveLength(5);
    expect(text).toContain('and 3 more');
  });

  it('uses the value unchanged when the project list cannot be read', async () => {
    const { gw, fetchImpl } = gateway({ [`${BASE}/5.1/projects`]: { status: 500, body: {} } });
    const result = await gw.callTool('list_tasks', { projectId: '10001' });
    expect(result.isError).toBe(true);
    expect(calledPaths(fetchImpl).at(-1)).toBe('/5.2/projects/10001/tasks');
  });

  it('resolves within DALUX_ALLOWED_PROJECT_IDS only and does not reveal other projects', async () => {
    process.env.DALUX_ALLOWED_PROJECT_IDS = `${HARBOUR},${DEPOT_N}`;
    const { gw, fetchImpl } = gateway({
      [`${BASE}/5.1/projects`]: LIST,
      [tasksOf(HARBOUR)]: PAGE,
      [tasksOf(DEPOT_N)]: PAGE,
    });

    expect((await gw.callTool('list_tasks', { projectId: 'Harbour Bridge' })).isError).toBeUndefined();
    // Number 10004 is shared with a project outside the allowlist: only the allowed one counts.
    expect((await gw.callTool('list_tasks', { projectId: '10004' })).isError).toBeUndefined();

    const outside = await gw.callTool('list_tasks', { projectId: '10002' });
    expect(outside.isError).toBe(true);
    const text = outside.content[0]?.text ?? '';
    expect(text).toContain('projects allowed on this instance');
    for (const hidden of [SCHOOL_A, SCHOOL_B, DEPOT_S, 'Example School', 'South Depot']) {
      expect(text).not.toContain(hidden);
    }

    const similar = await gw.callTool('list_tasks', { projectId: 'Depot' });
    expect(similar.content[0]?.text).toContain(DEPOT_N);
    expect(similar.content[0]?.text).not.toContain(DEPOT_S);

    // An internal id outside the allowlist is denied without any request.
    fetchImpl.mockClear();
    const denied = await gw.callTool('list_tasks', { projectId: SCHOOL_A });
    expect(denied.content[0]?.text).toContain('DALUX_ALLOWED_PROJECT_IDS');
    expect(fetchImpl).not.toHaveBeenCalled();

    expect(calledPaths(fetchImpl)).not.toContain(`/5.2/projects/${SCHOOL_A}/tasks`);
  });

  it('caches the project list per client instance', async () => {
    const fetchA = stubFetch({ [`${BASE}/5.1/projects`]: LIST });
    const fetchB = stubFetch({ [`${BASE}/5.1/projects`]: LIST });
    const a = new DaluxClient({ apiKey: 'k', baseUrl: BASE, fetchImpl: fetchA as unknown as typeof fetch });
    const b = new DaluxClient({ apiKey: 'k', baseUrl: BASE, fetchImpl: fetchB as unknown as typeof fetch });

    expect(await resolveProjectRef(a, '10001', { now: 0 })).toMatchObject({ projectId: HARBOUR, matchedBy: 'number' });
    expect(await resolveProjectRef(a, 'North Depot', { now: 1000 })).toMatchObject({ projectId: DEPOT_N, matchedBy: 'name' });
    expect(fetchA).toHaveBeenCalledTimes(1);

    expect(await resolveProjectRef(b, '10001', { now: 0 })).toMatchObject({ projectId: HARBOUR, matchedBy: 'number' });
    expect(fetchB).toHaveBeenCalledTimes(1);

    await resolveProjectRef(a, '10001', { now: PROJECT_LIST_TTL_MS + 1 });
    expect(fetchA).toHaveBeenCalledTimes(2);
  });

  it('shares one project list request between concurrent lookups', async () => {
    const fetchImpl = stubFetch({ [`${BASE}/5.1/projects`]: LIST });
    const client = new DaluxClient({ apiKey: 'k', baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch });
    const results = await Promise.all(['10001', '10002', 'North Depot'].map(ref => resolveProjectRef(client, ref, { now: 0 })));
    expect(results.map(r => r.projectId)).toEqual([HARBOUR, SCHOOL_A, DEPOT_N]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('records the resolved id in the audit log', async () => {
    const auditPath = join(tempDir, 'audit.jsonl');
    process.env.DALUX_AUDIT_LOG = auditPath;
    const { gw } = gateway({ [`${BASE}/5.1/projects`]: LIST, [tasksOf(HARBOUR)]: PAGE });
    await gw.callTool('list_tasks', { projectId: 'Harbour Bridge' });
    await gw.callTool('list_tasks', { projectId: 'nothing like it' });

    const lines = auditLines(auditPath);
    const ok = lines.filter(line => line.action === 'start' || line.action === 'finish');
    expect(ok).toHaveLength(2);
    for (const line of ok) {
      expect(line.target).toMatchObject({ projectId: HARBOUR });
    }
    const failed = lines.find(line => line.action === 'error');
    expect(failed?.error).toBe(PROJECT_REF_AUDIT_MESSAGE);
    expect(failed?.target).not.toHaveProperty('projectId');
    expect(failed?.target).toMatchObject({ projectIdSha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const raw = JSON.stringify(lines);
    for (const name of ['nothing like it', 'Harbour Bridge']) {
      expect(raw).not.toContain(name);
    }
  });

  it('resolves over the MCP path too', async () => {
    const { mcpClient, fetchImpl } = await connect({ [`${BASE}/5.1/projects`]: LIST, [tasksOf(HARBOUR)]: PAGE });
    const result = await mcpClient.callTool({ name: 'dalux_list_tasks', arguments: { projectId: '10001' } });
    expect(result.isError).toBeFalsy();
    expect(calledPaths(fetchImpl)).toEqual(['/5.1/projects', `/5.2/projects/${HARBOUR}/tasks`]);
  });

  it('describes the accepted project references in the tool schema', async () => {
    const { mcpClient } = await connect();
    const { tools } = await mcpClient.listTools();
    const schema = tools.find(tool => tool.name === 'dalux_get_task')?.inputSchema as {
      properties: Record<string, { type?: string; description?: string }>;
    };
    expect(schema.properties.projectId?.type).toBe('string');
    expect(schema.properties.projectId?.description).toContain('a project number or exact name is also accepted');
  });
});

describe('project reference safeguards', () => {
  it('adds the resolved project to read results', async () => {
    const { gw } = gateway({ [`${BASE}/5.1/projects`]: LIST, [tasksOf(HARBOUR)]: PAGE });
    const result = await gw.callTool('list_tasks', { projectId: 'harbour bridge' });
    expect(result.structuredContent).toMatchObject({
      resolvedProject: { projectId: HARBOUR, number: '10001', projectName: 'Harbour Bridge', matchedBy: 'name' },
    });
  });

  it('does not resolve a number or name when the project list is truncated', async () => {
    process.env.DALUX_ENABLE_WRITES = 'true';
    const truncated: Stub = {
      body: {
        items: PROJECTS.map(data => ({ data })),
        links: [
          { rel: 'self', href: `${BASE}/5.1/projects` },
          { rel: 'nextPage', href: `${BASE}/5.1/projects?bookmark=next` },
        ],
      },
    };
    const { gw, fetchImpl } = gateway({ [`${BASE}/5.1/projects`]: truncated });
    // Read: passed through unchanged, so Dalux decides (no stub here: 404).
    const read = await gw.callTool('list_tasks', { projectId: '10001' });
    expect(read.isError).toBe(true);
    expect(calledPaths(fetchImpl).at(-1)).toBe('/5.2/projects/10001/tasks');
    expect(calledPaths(fetchImpl)).not.toContain(`/5.2/projects/${HARBOUR}/tasks`);

    // Write: refused before any write request.
    fetchImpl.mockClear();
    const write = await gw.callTool('change_project', { action: 'update', projectId: '10001', patch: { projectName: 'X' } });
    expect(write.isError).toBe(true);
    expect(write.content[0]?.text).toContain('too long to read completely');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('treats a value that is one project number and another project name as ambiguous', async () => {
    const list: Stub = {
      body: {
        items: [
          { data: { projectId: HARBOUR, number: '30000', projectName: 'Harbour Bridge' } },
          { data: { projectId: DEPOT_N, number: '30001', projectName: '30000' } },
        ],
      },
    };
    const { gw, fetchImpl } = gateway({ [`${BASE}/5.1/projects`]: list });
    const result = await gw.callTool('list_tasks', { projectId: '30000' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('matches 2 projects');
    expect(result.content[0]?.text).toContain(HARBOUR);
    expect(result.content[0]?.text).toContain(DEPOT_N);
    expect(calledPaths(fetchImpl)).toEqual(['/5.1/projects']);
  });

  it('treats a short id that is also another project number as ambiguous', async () => {
    const list: Stub = {
      body: { items: [{ data: { projectId: '77', number: '1' } }, { data: { projectId: '78', number: '77' } }] },
    };
    const { gw } = gateway({ [`${BASE}/5.1/projects`]: list });
    const result = await gw.callTool('list_tasks', { projectId: '77' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('matches 2 projects');
  });

  it('refuses a number or name on write tools and names the projectId to retry with', async () => {
    process.env.DALUX_ENABLE_WRITES = 'true';
    const { gw, fetchImpl } = gateway({ [`${BASE}/5.1/projects`]: LIST });
    const update = await gw.callTool('change_project', {
      action: 'update',
      projectId: 'Harbour Bridge',
      patch: { projectName: 'X' },
    });
    expect(update.isError).toBe(true);
    const text = update.content[0]?.text ?? '';
    expect(text).toContain(`resolved to projectId ${HARBOUR}`);
    expect(text).toContain(`Retry with projectId ${HARBOUR}`);

    const company = await gw.callTool('change_company', {
      scope: 'project',
      action: 'create',
      projectId: '10001',
      body: { name: 'Example Subcontractor' },
    });
    expect(company.isError).toBe(true);
    expect(company.content[0]?.text).toContain(`resolved to projectId ${HARBOUR}`);

    const upload = await gw.callTool('upload_file', {
      projectId: '10001',
      fileAreaId: 'a',
      fileName: 'x.txt',
      contentBase64: Buffer.from('x').toString('base64'),
      folderId: 'd',
    });
    expect(upload.isError).toBe(true);
    expect(upload.content[0]?.text).toContain(`resolved to projectId ${HARBOUR}`);
    expect(calledPaths(fetchImpl)).toEqual(['/5.1/projects']);
  });

  it('gives no similar-project hints for references shorter than three characters', async () => {
    const { gw } = gateway({ [`${BASE}/5.1/projects`]: LIST });
    const text = (await gw.callTool('list_tasks', { projectId: 'De' })).content[0]?.text ?? '';
    expect(text).toContain('No project with id, number or name "De"');
    for (const id of [HARBOUR, SCHOOL_A, SCHOOL_B, DEPOT_N, DEPOT_S]) {
      expect(text).not.toContain(id);
    }
  });

  it('names no candidate projects while dalux_list_projects is disabled', async () => {
    process.env.DALUX_DISABLED_TOOLS = 'dalux_list_projects';
    process.env.DALUX_ENABLE_WRITES = 'true';
    const { gw } = gateway({ [`${BASE}/5.1/projects`]: LIST, [tasksOf(HARBOUR)]: PAGE });
    const messages = [
      (await gw.callTool('list_tasks', { projectId: '10004' })).content[0]?.text ?? '',
      (await gw.callTool('list_tasks', { projectId: 'Depot' })).content[0]?.text ?? '',
      (await gw.callTool('change_project', { action: 'update', projectId: '10001', patch: { projectName: 'X' } }))
        .content[0]?.text ?? '',
    ];
    for (const message of messages) {
      expect(message).not.toBe('');
      for (const leak of [HARBOUR, DEPOT_N, DEPOT_S, 'North', 'South', 'Harbour']) {
        expect(message).not.toContain(leak);
      }
    }
    // Reads still resolve.
    expect((await gw.callTool('list_tasks', { projectId: '10001' })).isError).toBeUndefined();
  });

  it('does not resolve projectId on catalog scopes', async () => {
    const { gw, fetchImpl } = gateway({ [`${BASE}/5.1/projects`]: LIST });
    await gw.callTool('list_companies', { scope: 'catalog', projectId: 'Harbour Bridge' });
    expect(calledPaths(fetchImpl)).not.toContain('/5.1/projects');
  });

  it('logs a hash for a projectId that is not an exact id', async () => {
    const auditPath = join(tempDir, 'audit.jsonl');
    process.env.DALUX_AUDIT_LOG = auditPath;
    const { gw } = gateway({ [`${BASE}/5.1/projects`]: { status: 500, body: {} } });
    await gw.callTool('list_tasks', { projectId: 'Some Project Name' });
    const lines = auditLines(auditPath);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line.target).not.toHaveProperty('projectId');
      expect(line.target).toHaveProperty('projectIdSha256');
    }
    expect(JSON.stringify(lines)).not.toContain('Some Project Name');
  });

  it('does not keep a project list fetched before the cache was cleared', async () => {
    const fetchImpl = stubFetch({ [`${BASE}/5.1/projects`]: LIST });
    const client = new DaluxClient({ apiKey: 'k', baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch });
    const pending = resolveProjectRef(client, '10001', { now: 0 });
    forgetProjectList(client);
    await pending;
    await resolveProjectRef(client, '10001', { now: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('project list after project writes', () => {
  it('is read again after a project update', async () => {
    process.env.DALUX_ENABLE_WRITES = 'true';
    const { gw, fetchImpl } = gateway({
      [`${BASE}/5.1/projects`]: LIST,
      [`${BASE}/5.0/projects/${HARBOUR}`]: { body: { data: { projectId: HARBOUR } } },
      [tasksOf(HARBOUR)]: PAGE,
    });
    await gw.callTool('list_tasks', { projectId: '10001' });
    const update = await gw.callTool('change_project', { action: 'update', projectId: HARBOUR, patch: { projectName: 'X' } });
    expect(update.isError, texts(update).join(' ')).toBeUndefined();
    await gw.callTool('list_tasks', { projectId: '10001' });
    expect(calledPaths(fetchImpl).filter(path => path === '/5.1/projects')).toHaveLength(2);
  });
});
