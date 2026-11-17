import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DaluxClient } from '../src/dalux/client.js';
import {
  boxProBlocker,
  getProjectModules,
  licenseSummary,
  MODULE_CACHE_MAX_ENTRIES,
  MODULE_CACHE_TTL_MS,
  rememberProjectModules,
  UNKNOWN_CACHE_TTL_MS,
  type ProjectModule,
} from '../src/dalux/license.js';
import { checkInputPolicy, projectIdInLink, validatePolicyConfig } from '../src/dalux/policy.js';
import { isNoTaskChanges } from '../src/dalux/tasks.js';
import { DaluxHttpError } from '../src/errors.js';
import type { GatewayJsonObject } from '../src/gateway.js';
import { BASE, auditLines, connect, gateway, stubFetch, texts, type Stub } from './helpers.js';

const originalEnv = { ...process.env };
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'dalux-license-'));
});

afterEach(() => {
  process.env = { ...originalEnv };
  rmSync(tempDir, { recursive: true, force: true });
});

const PROJECT = `${BASE}/5.0/projects/900000000000000001`;
const AREAS = `${BASE}/5.1/projects/900000000000000001/file_areas`;
const project = (modules: unknown) => ({ data: { projectId: '900000000000000001', modules } });
const LIGHT = project([{ type: 'box', tier: 'light' }, { type: 'field', tier: 'field' }]);
const PRO = project([{ type: 'box', tier: 'pro' }, { type: 'field', tier: 'field' }]);
const FIELD_ONLY = project([{ type: 'field', tier: 'field' }]);
const PAGE = { items: [{ data: { id: 'x' } }], links: [] };
const BOX_PRO_MESSAGE = "The Dalux Build API's Box endpoints require Box Pro; project 900000000000000001 has Box light.";

function calls(fetchImpl: ReturnType<typeof stubFetch>): string[] {
  return fetchImpl.mock.calls.map(([input, init]) => `${init?.method ?? 'GET'} ${String(input).replace(BASE, '')}`);
}

describe('boxProBlocker', () => {
  const cases: Array<[string, unknown, string | undefined]> = [
    ['light', [{ type: 'box', tier: 'light' }], 'light'],
    ['basic, standard and field tiers', [{ type: 'box', tier: 'standard' }], 'standard'],
    ['no box entry in a well-formed list', [{ type: 'field', tier: 'field' }], 'not enabled'],
    ['pro', [{ type: 'box', tier: 'pro' }], undefined],
    ['pro with other casing', [{ type: 'Box', tier: 'Pro' }], undefined],
    ['light with other casing', [{ type: 'BOX', tier: 'Light' }], 'light'],
    ['any box entry pro', [{ type: 'box', tier: 'light' }, { type: 'box', tier: 'pro' }], undefined],
    ['missing tier', [{ type: 'box' }], undefined],
    ['null tier', [{ type: 'box', tier: null }], undefined],
    ['unrecognised tier', [{ type: 'box', tier: 'enterprise' }], undefined],
    ['recognised and unrecognised tiers', [{ type: 'box', tier: 'light' }, { type: 'box', tier: 'enterprise' }], undefined],
    ['empty list', [], undefined],
    ['non-object entries', ['box'], undefined],
    ['entry without a type next to a field entry', [{ tier: 'pro' }, { type: 'field', tier: 'field' }], undefined],
    ['null entry', [null], undefined],
    ['unknown modules', undefined, undefined],
  ];

  it.each(cases)('%s', (_label, modules, expected) => {
    expect(boxProBlocker(modules as ProjectModule[] | undefined)).toBe(expected);
  });
});

describe('Box Pro pre-check', () => {
  const boxCalls: Array<[string, GatewayJsonObject]> = [
    ['list_file_areas', { projectId: '900000000000000001' }],
    ['list_folders', { projectId: '900000000000000001', fileAreaId: 'a' }],
    ['list_files', { projectId: '900000000000000001', fileAreaId: 'a' }],
    ['list_version_sets', { projectId: '900000000000000001' }],
    ['download_file', { projectId: '900000000000000001', fileAreaId: 'a', fileId: 'f', fileRevisionId: 'r' }],
    ['list_property_mappings', { scope: 'folder', projectId: '900000000000000001', fileAreaId: 'a', folderId: 'd' }],
    ['list_property_mappings', { scope: 'file', projectId: '900000000000000001', fileAreaId: 'a', fileId: 'f' }],
  ];

  it.each(boxCalls)('%s fails fast without Box Pro', async (tool, input) => {
    const { gw, fetchImpl } = gateway({ [PROJECT]: { body: LIGHT } });
    const result = await gw.callTool(tool, input);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(BOX_PRO_MESSAGE);
    expect(result.content[0]?.text).toContain('dalux_get_project refreshes them');
    expect(calls(fetchImpl)).toEqual(['GET /5.0/projects/900000000000000001']);
  });

  it('reports a project without a Box module', async () => {
    const { gw } = gateway({ [PROJECT]: { body: FIELD_ONLY } });
    const result = await gw.callTool('list_file_areas', { projectId: '900000000000000001' });
    expect(result.content[0]?.text).toContain('project 900000000000000001 has Box not enabled');
  });

  it('does not check Field tools or project/company writes', async () => {
    process.env.DALUX_ENABLE_WRITES = 'true';
    const readOnly = project([{ type: 'box', tier: 'light', restriction: 'readOnly' }]);
    const { gw, fetchImpl } = gateway({
      [PROJECT]: { body: readOnly },
      [`${BASE}/5.2/projects/900000000000000001/tasks`]: { body: PAGE },
      [`${BASE}/3.1/projects/900000000000000001/companies`]: { body: { data: { companyId: 'c' } } },
    });
    expect((await gw.callTool('list_tasks', { projectId: '900000000000000001' })).isError).toBeFalsy();
    expect((await gw.callTool('change_project', { action: 'update', projectId: '900000000000000001', patch: { projectName: 'X' } })).isError).toBeFalsy();
    expect(
      (await gw.callTool('change_company', { scope: 'project', action: 'create', projectId: '900000000000000001', body: { name: 'X' } })).isError,
    ).toBeFalsy();
    expect(calls(fetchImpl)).toEqual(['GET /5.2/projects/900000000000000001/tasks', 'PATCH /5.0/projects/900000000000000001', 'POST /3.1/projects/900000000000000001/companies']);
  });

  it('refuses uploads without Box Pro after validating the input, with one lookup', async () => {
    process.env.DALUX_ENABLE_WRITES = 'true';
    const { gw, fetchImpl } = gateway({ [PROJECT]: { body: LIGHT } });
    const upload = {
      projectId: '900000000000000001',
      fileAreaId: 'a',
      folderId: 'd',
      fileName: 'a.txt',
      contentBase64: Buffer.from('x').toString('base64'),
    };
    const invalid = await gw.callTool('upload_file', { ...upload, fileId: 'f' });
    expect(invalid.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
    const result = await gw.callTool('upload_file', upload);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(BOX_PRO_MESSAGE);
    expect(calls(fetchImpl)).toEqual(['GET /5.0/projects/900000000000000001']);
  });

  it('looks up once per upload when the modules are unknown', async () => {
    process.env.DALUX_ENABLE_WRITES = 'true';
    const { gw, fetchImpl } = gateway({
      [PROJECT]: { body: { data: { projectId: '900000000000000001' } } },
      [`${BASE}/1.0/projects/900000000000000001/file_areas/a/upload`]: { body: { data: { uploadGuid: 'g' } } },
      [`${BASE}/1.0/projects/900000000000000001/file_areas/a/upload/g`]: { body: {} },
      [`${BASE}/2.0/projects/900000000000000001/file_areas/a/upload/g/finalize`]: { body: { data: { fileId: 'f' } } },
    });
    const result = await gw.callTool('upload_file', {
      projectId: '900000000000000001',
      fileAreaId: 'a',
      folderId: 'd',
      fileName: 'a.txt',
      contentBase64: Buffer.from('x').toString('base64'),
    });
    expect(result.isError).toBeFalsy();
    expect(calls(fetchImpl)).toEqual([
      'GET /5.0/projects/900000000000000001',
      'POST /1.0/projects/900000000000000001/file_areas/a/upload',
      'POST /1.0/projects/900000000000000001/file_areas/a/upload/g',
      'POST /2.0/projects/900000000000000001/file_areas/a/upload/g/finalize',
    ]);
  });

  it('calls the Box endpoint with Box Pro and caches the module lookup', async () => {
    const { gw, fetchImpl } = gateway({ [PROJECT]: { body: PRO }, [AREAS]: { body: PAGE } });
    expect((await gw.callTool('list_file_areas', { projectId: '900000000000000001' })).isError).toBeFalsy();
    expect((await gw.callTool('list_file_areas', { projectId: '900000000000000001' })).isError).toBeFalsy();
    expect(calls(fetchImpl)).toEqual(['GET /5.0/projects/900000000000000001', 'GET /5.1/projects/900000000000000001/file_areas', 'GET /5.1/projects/900000000000000001/file_areas']);
  });

  it('can be turned off with DALUX_LICENSE_PRECHECK=false', async () => {
    process.env.DALUX_LICENSE_PRECHECK = 'false';
    const { gw, fetchImpl } = gateway({ [PROJECT]: { body: LIGHT }, [AREAS]: { body: PAGE } });
    expect((await gw.callTool('list_file_areas', { projectId: '900000000000000001' })).isError).toBeFalsy();
    expect(calls(fetchImpl)).toEqual(['GET /5.1/projects/900000000000000001/file_areas']);
  });

  it('validates DALUX_LICENSE_PRECHECK at startup', () => {
    for (const value of ['true', 'false', '']) {
      process.env.DALUX_LICENSE_PRECHECK = value;
      expect(() => validatePolicyConfig()).not.toThrow();
    }
    process.env.DALUX_LICENSE_PRECHECK = 'no';
    expect(() => validatePolicyConfig()).toThrow('DALUX_LICENSE_PRECHECK');
    expect(() => gateway()).toThrow('DALUX_LICENSE_PRECHECK');
  });

  it('works over the MCP path', async () => {
    const { mcpClient, fetchImpl } = await connect({ [PROJECT]: { body: LIGHT } });
    const result = await mcpClient.callTool({ name: 'dalux_list_file_areas', arguments: { projectId: '900000000000000001' } });
    expect(result.isError).toBe(true);
    expect(texts(result)[0]).toContain(BOX_PRO_MESSAGE);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('module lookup failures', () => {
  function areasAfter(lookup: Stub) {
    return gateway({ [PROJECT]: lookup, [AREAS]: { body: PAGE } });
  }

  it.each([
    ['HTTP 500', { status: 500, body: { message: 'boom' } }],
    ['HTTP 403', { status: 403, body: { errorCode: 'E40301' } }],
    ['HTTP 404', { status: 404, body: { errorCode: 'E40401' } }],
    ['no modules', { body: { data: { projectId: '900000000000000001' } } }],
    ['non-JSON body', { raw: 'not json' }],
  ] as Array<[string, Stub]>)('%s falls through and is remembered as unknown', async (_label, lookup) => {
    const { gw, fetchImpl } = areasAfter(lookup);
    expect((await gw.callTool('list_file_areas', { projectId: '900000000000000001' })).isError).toBeFalsy();
    expect((await gw.callTool('list_file_areas', { projectId: '900000000000000001' })).isError).toBeFalsy();
    expect(calls(fetchImpl)).toEqual(['GET /5.0/projects/900000000000000001', 'GET /5.1/projects/900000000000000001/file_areas', 'GET /5.1/projects/900000000000000001/file_areas']);
  });

  it('makes a single attempt on 429 and does not wait for Retry-After', async () => {
    const sleep = vi.fn(async () => undefined);
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (String(input).startsWith(PROJECT)) {
        return new Response('{}', { status: 429, headers: { 'retry-after': '4', 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify(PAGE), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const client = new DaluxClient({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch, sleep });
    expect(await getProjectModules(client, '900000000000000001')).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('makes a single attempt on a network error, with a short timeout', async () => {
    const signals: AbortSignal[] = [];
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.signal) {
        signals.push(init.signal);
      }
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    });
    const sleep = vi.fn(async () => undefined);
    const client = new DaluxClient({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch, sleep });
    expect(await getProjectModules(client, '900000000000000001')).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('treats a lookup timeout as unknown', async () => {
    const fetchImpl = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    );
    const client = new DaluxClient({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch, timeoutMs: 20 });
    expect(await getProjectModules(client, '900000000000000001')).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('shares one in-flight lookup between concurrent calls', async () => {
    const { gw, fetchImpl } = gateway({ [PROJECT]: { body: PRO }, [AREAS]: { body: PAGE } });
    const results = await Promise.all(Array.from({ length: 6 }, () => gw.callTool('list_file_areas', { projectId: '900000000000000001' })));
    expect(results.every(result => !result.isError)).toBe(true);
    expect(calls(fetchImpl).filter(call => call === 'GET /5.0/projects/900000000000000001')).toHaveLength(1);
  });
});

describe('module cache', () => {
  function client(routes: Record<string, Stub>) {
    const fetchImpl = stubFetch(routes);
    return { client: new DaluxClient({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch }), fetchImpl };
  }

  it('expires known modules after 5 minutes and unknown results after 60 s', async () => {
    const { client: c, fetchImpl } = client({ [PROJECT]: { body: PRO } });
    await getProjectModules(c, '900000000000000001', 0);
    await getProjectModules(c, '900000000000000001', MODULE_CACHE_TTL_MS - 1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await getProjectModules(c, '900000000000000001', MODULE_CACHE_TTL_MS + 1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    expect(await getProjectModules(c, 'missing', 0)).toBeUndefined();
    expect(await getProjectModules(c, 'missing', UNKNOWN_CACHE_TTL_MS - 1)).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(await getProjectModules(c, 'missing', UNKNOWN_CACHE_TTL_MS + 1)).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('is bounded and per client', async () => {
    const { client: c, fetchImpl } = client({});
    for (let i = 0; i <= MODULE_CACHE_MAX_ENTRIES; i += 1) {
      rememberProjectModules(c, `p${i}`, PRO);
    }
    expect(await getProjectModules(c, `p${MODULE_CACHE_MAX_ENTRIES}`)).toEqual(PRO.data.modules);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await getProjectModules(c, 'p0')).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const other = client({});
    expect(await getProjectModules(other.client, `p${MODULE_CACHE_MAX_ENTRIES}`)).toBeUndefined();
    expect(other.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('summarises modules', () => {
    expect(licenseSummary([])).toEqual({ box: null, field: null, restrictions: [] });
    expect(licenseSummary([{ type: 'field', tier: 'basic', restriction: 'sandbox' }, 'x' as never])).toEqual({
      box: null,
      field: 'basic',
      restrictions: ['field:sandbox'],
    });
  });
});

describe('dalux_get_project license summary', () => {
  it('adds a license summary next to the raw data', async () => {
    const trial = project([{ type: 'box', tier: 'light', restriction: 'trial' }, { type: 'field', tier: 'field', restriction: 'readOnly' }]);
    const { gw } = gateway({ [PROJECT]: { body: trial } });
    const result = await gw.callTool('get_project', { projectId: '900000000000000001' });
    expect(result.structuredContent).toEqual({
      ...trial,
      license: { box: 'light', field: 'field', restrictions: ['box:trial', 'field:readOnly'] },
    });
  });

  it('adds it alongside project and metadata with includeMetadata', async () => {
    const { gw } = gateway({ [PROJECT]: { body: LIGHT }, [`${BASE}/1.0/projects/900000000000000001/metadata`]: { body: { items: [] } } });
    const result = await gw.callTool('get_project', { projectId: '900000000000000001', includeMetadata: true });
    expect(result.structuredContent).toEqual({
      project: LIGHT,
      metadata: { items: [] },
      license: { box: 'light', field: 'field', restrictions: [] },
    });
  });

  it('never replaces a license field returned by Dalux', async () => {
    const body = { ...LIGHT, license: 'from-dalux' };
    const { gw } = gateway({ [PROJECT]: { body } });
    expect((await gw.callTool('get_project', { projectId: '900000000000000001' })).structuredContent).toEqual(body);
  });

  it('leaves the result unchanged when the project has no modules', async () => {
    const { gw } = gateway({ [PROJECT]: { body: { data: { projectId: '900000000000000001' } } } });
    expect((await gw.callTool('get_project', { projectId: '900000000000000001' })).structuredContent).toEqual({ data: { projectId: '900000000000000001' } });
  });

  it('refreshes the module cache', async () => {
    const routes: Record<string, Stub> = { [PROJECT]: { body: LIGHT }, [AREAS]: { body: PAGE } };
    const { gw } = gateway(routes);
    expect((await gw.callTool('list_file_areas', { projectId: '900000000000000001' })).isError).toBe(true);
    routes[PROJECT] = { body: PRO };
    await gw.callTool('get_project', { projectId: '900000000000000001' });
    expect((await gw.callTool('list_file_areas', { projectId: '900000000000000001' })).isError).toBeFalsy();
  });
});

describe('E40301 from Dalux', () => {
  it('names the license and Box Pro', async () => {
    const { gw } = gateway({
      [PROJECT]: { status: 500, body: {} },
      [AREAS]: {
        status: 403,
        body: { httpStatusCode: 403, errorCode: 'E40301', message: 'This call requires the project to have Box Pro enabled' },
      },
    });
    const text = (await gw.callTool('list_file_areas', { projectId: '900000000000000001' })).content[0]?.text ?? '';
    expect(text).toContain('E40301');
    expect(text).toMatch(/project license or module/);
    expect(text).toContain('require Box Pro');
  });
});

describe('dalux_get_task_changes without changes', () => {
  const changes = `${BASE}/2.3/projects/900000000000000001/tasks/changes`;
  const noChanges: Stub = {
    status: 404,
    body: { httpStatusCode: 404, errorCode: 'E40401', message: 'No task changes on project' },
  };

  it('returns an empty page for 404 "No task changes on project"', async () => {
    const { gw } = gateway({ [changes]: noChanges });
    const result = await gw.callTool('get_task_changes', { projectId: '900000000000000001' });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      items: [],
      pagesFetched: 1,
      endOfIncrementalStream: false,
      note: 'Dalux reports no task changes on this project.',
    });
  });

  it('keeps the cursor when continuing from a pageLink', async () => {
    const link = `${changes}?bookmark=abc`;
    const { gw } = gateway({ [changes]: noChanges });
    const result = await gw.callTool('get_task_changes', { projectId: '900000000000000001', pageLink: link });
    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as { nextPage?: string }).nextPage).toBe(link);
  });

  it('matches only the exact message on a 404', () => {
    const error = (status: number, payload: unknown) => new DaluxHttpError({ status, url: `${BASE}/x`, payload });
    expect(isNoTaskChanges(error(404, { message: 'No task changes on project.' }))).toBe(true);
    expect(isNoTaskChanges(error(404, { message: 'Project 1 not found; no task changes can be listed' }))).toBe(false);
    expect(isNoTaskChanges(error(404, { error: 'No task changes on project' }))).toBe(false);
    expect(isNoTaskChanges(error(404, 'No task changes on project'))).toBe(false);
    expect(isNoTaskChanges(error(400, { message: 'No task changes on project' }))).toBe(false);
    expect(isNoTaskChanges(new Error('No task changes on project'))).toBe(false);
  });

  it('keeps other 404s as errors', async () => {
    const { gw } = gateway({ [changes]: { status: 404, body: { errorCode: 'E40401', message: 'Project not found' } } });
    expect((await gw.callTool('get_task_changes', { projectId: '900000000000000001' })).isError).toBe(true);
  });
});

describe('dalux_list_property_mappings', () => {
  const routes = (url: string): Record<string, Stub> => ({ [PROJECT]: { body: PRO }, [`${BASE}${url}`]: { body: PAGE } });

  it.each([
    [{ scope: 'folder', projectId: '900000000000000001', fileAreaId: 'a', folderId: 'd' }, '/1.1/projects/900000000000000001/file_areas/a/folders/d/files/properties/1.0/mappings'],
    [{ scope: 'file', projectId: '900000000000000001', fileAreaId: 'a', fileId: 'f' }, '/1.1/projects/900000000000000001/file_areas/a/files/f/properties/1.0/mappings'],
    [{ scope: 'file', projectId: '900000000000000001', fileAreaId: 'a', key: 'p9' }, '/1.0/projects/900000000000000001/file_areas/a/files/properties/1.0/mappings/p9/values'],
    [{ scope: 'folder', projectId: '900000000000000001', fileAreaId: 'a', key: 'p9' }, '/1.0/projects/900000000000000001/file_areas/a/files/properties/1.0/mappings/p9/values'],
    [{ scope: 'project' }, '/1.0/projects/metadata/1.0/mappings'],
    [{ scope: 'project', key: 'k' }, '/1.0/projects/metadata/1.0/mappings/k/values'],
    [{ scope: 'project', projectId: '900000000000000001' }, '/1.0/projects/900000000000000001/metadata/1.0/mappings'],
    [{ scope: 'project', projectId: '900000000000000001', key: 'k' }, '/1.0/projects/900000000000000001/metadata/1.0/mappings/k/values'],
    [{ scope: 'companyCatalog' }, '/1.0/companyCatalog/metadata/1.0/mappings'],
    [{ scope: 'companyCatalog', key: 'k' }, '/1.0/companyCatalog/metadata/1.0/mappings/k/values'],
    [{ scope: 'companyCatalog', companyId: 'c' }, '/1.0/companyCatalog/c/metadata/1.0/mappings'],
    [{ scope: 'companyCatalog', companyId: 'c', key: 'k' }, '/1.0/companyCatalog/c/metadata/1.0/mappings/k/values'],
  ] as Array<[GatewayJsonObject, string]>)('%j -> %s', async (input, path) => {
    const { gw, fetchImpl } = gateway(routes(path));
    const result = await gw.callTool('list_property_mappings', input);
    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as { items: unknown[] }).items).toEqual(PAGE.items);
    expect(calls(fetchImpl).at(-1)).toBe(`GET ${path}`);
    const boxScope = input.scope === 'folder' || input.scope === 'file';
    expect(calls(fetchImpl).includes('GET /5.0/projects/900000000000000001')).toBe(boxScope);
  });

  it('requires the ids of the chosen scope', async () => {
    const { gw, fetchImpl } = gateway({});
    const missingFolder = await gw.callTool('list_property_mappings', { scope: 'folder', projectId: '900000000000000001', fileAreaId: 'a' });
    expect(missingFolder.content[0]?.text).toContain('folderId is required for scope=folder');
    const missingProject = await gw.callTool('list_property_mappings', { scope: 'file', fileAreaId: 'a', fileId: 'f' });
    expect(missingProject.content[0]?.text).toContain('projectId is required for scope=file');
    const traversal = await gw.callTool('list_property_mappings', { scope: 'project', key: '..' });
    expect(traversal.isError).toBe(true);
    expect(calls(fetchImpl).filter(call => !call.includes('/5.0/projects/'))).toEqual([]);
  });

  it('respects DALUX_ALLOWED_PROJECT_IDS, including pageLink', async () => {
    process.env.DALUX_ALLOWED_PROJECT_IDS = '900000000000000001';
    const globalPath = '/1.0/projects/metadata/1.0/mappings';
    const { gw, fetchImpl } = gateway({ ...routes(globalPath), [`${BASE}/1.0/projects/900000000000000001/metadata/1.0/mappings`]: { body: PAGE } });

    const outside = await gw.callTool('list_property_mappings', { scope: 'project', projectId: '900000000000000002' });
    expect(outside.content[0]?.text).toContain('DALUX_ALLOWED_PROJECT_IDS');
    const otherLink = await gw.callTool('list_property_mappings', {
      scope: 'project',
      pageLink: `${BASE}/1.0/projects/900000000000000002/metadata/1.0/mappings?bookmark=x`,
    });
    expect(otherLink.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();

    // Global metadata mappings are account-wide: their links name no project.
    const global = await gw.callTool('list_property_mappings', {
      scope: 'project',
      pageLink: `${BASE}${globalPath}?bookmark=x`,
    });
    expect(global.isError).toBeFalsy();
    const values = await gw.callTool('list_property_mappings', {
      scope: 'project',
      key: 'k',
      pageLink: `${BASE}/1.0/projects/metadata/1.0/mappings/k/values?bookmark=x`,
    });
    expect(values.content[0]?.text).not.toContain('DALUX_ALLOWED_PROJECT_IDS');
  });

  it('records key (hashed) and includeProperties in the audit log', async () => {
    const auditPath = join(tempDir, 'audit.jsonl');
    process.env.DALUX_AUDIT_LOG = auditPath;
    const { gw } = gateway({
      [`${BASE}/1.0/projects/900000000000000001/metadata/1.0/mappings/phase/values`]: { body: PAGE },
      [PROJECT]: { body: PRO },
      [`${BASE}/6.1/projects/900000000000000001/file_areas/a/files`]: { body: PAGE },
    });
    await gw.callTool('list_property_mappings', { scope: 'project', projectId: '900000000000000001', key: 'phase' });
    await gw.callTool('list_files', { projectId: '900000000000000001', fileAreaId: 'a', includeProperties: true });
    const [start, finish, filesStart] = auditLines(auditPath);
    expect(start).toMatchObject({
      action: 'start',
      tool: 'dalux_list_property_mappings',
      target: { scope: 'project', projectId: '900000000000000001' },
    });
    expect((start?.target as Record<string, unknown>).keySha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(start)).not.toContain('phase');
    expect(finish).toMatchObject({ action: 'finish', status: 'ok' });
    expect(filesStart).toMatchObject({ tool: 'dalux_list_files', target: { includeProperties: true } });
  });

  it('works over the MCP path', async () => {
    const { mcpClient } = await connect({ [`${BASE}/1.0/companyCatalog/metadata/1.0/mappings`]: { body: PAGE } });
    const result = await mcpClient.callTool({ name: 'dalux_list_property_mappings', arguments: { scope: 'companyCatalog' } });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(texts(result)[0] ?? '{}').items).toEqual(PAGE.items);
  });
});

describe('projectIdInLink', () => {
  it('ignores global project metadata mapping links', () => {
    expect(projectIdInLink(`${BASE}/1.0/projects/metadata/1.0/mappings?bookmark=x`)).toBeUndefined();
    expect(projectIdInLink(`${BASE}/1.0/projects/metadata/1.0/mappings/k/values`)).toBeUndefined();
    expect(projectIdInLink(`${BASE}/1.0/projects/metadata/metadata/1.0/mappings`)).toBe('metadata');
    expect(projectIdInLink(`${BASE}/1.0/projects/7/metadata/1.0/mappings`)).toBe('7');
    expect(checkInputPolicy('dalux_list_property_mappings', { pageLink: `${BASE}/1.0/projects/metadata/1.0/mappings` }).allowed).toBe(true);
  });
});

describe('includeProperties', () => {
  it('is sent on file lists only when requested', async () => {
    const { gw, fetchImpl } = gateway({
      [PROJECT]: { body: PRO },
      [`${BASE}/6.1/projects/900000000000000001/file_areas/a/files`]: { body: PAGE },
      [`${BASE}/3.0/projects/900000000000000001/version_sets/v/files`]: { body: PAGE },
    });
    await gw.callTool('list_files', { projectId: '900000000000000001', fileAreaId: 'a', includeProperties: true });
    await gw.callTool('list_files', { projectId: '900000000000000001', fileAreaId: 'a' });
    await gw.callTool('list_version_sets', { projectId: '900000000000000001', versionSetId: 'v', includeFiles: true, includeProperties: true });
    expect(calls(fetchImpl)).toEqual([
      'GET /5.0/projects/900000000000000001',
      'GET /6.1/projects/900000000000000001/file_areas/a/files?includeProperties=true',
      'GET /6.1/projects/900000000000000001/file_areas/a/files',
      'GET /3.0/projects/900000000000000001/version_sets/v/files?includeProperties=true',
    ]);
  });
});
