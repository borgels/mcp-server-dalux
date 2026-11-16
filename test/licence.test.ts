import { afterEach, describe, expect, it } from 'vitest';
import { DaluxClient } from '../src/dalux/client.js';
import {
  getProjectModules,
  licenceSummary,
  MODULE_CACHE_MAX_ENTRIES,
  MODULE_CACHE_TTL_MS,
  rememberProjectModules,
} from '../src/dalux/licence.js';
import { DaluxHttpError } from '../src/errors.js';
import type { GatewayJsonObject } from '../src/gateway.js';
import { BASE, gateway, stubFetch, type Stub } from './helpers.js';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

const PROJECT = `${BASE}/5.0/projects/1`;
const LIGHT = { data: { projectId: '1', modules: [{ type: 'box', tier: 'light' }, { type: 'field', tier: 'field' }] } };
const PRO = { data: { projectId: '1', modules: [{ type: 'box', tier: 'pro' }, { type: 'field', tier: 'field' }] } };
const BOX_ONLY = { data: { projectId: '1', modules: [{ type: 'box', tier: 'pro' }] } };
const FIELD_ONLY = { data: { projectId: '1', modules: [{ type: 'field', tier: 'field' }] } };
const PAGE = { items: [{ data: { id: 'x' } }], links: [] };

function urls(fetchImpl: ReturnType<typeof stubFetch>): string[] {
  return fetchImpl.mock.calls.map(([input, init]) => `${init?.method ?? 'GET'} ${String(input).replace(BASE, '')}`);
}

function setup(routes: Record<string, Stub>) {
  return gateway(routes);
}

describe('Box Pro pre-check', () => {
  const boxCalls: Array<[string, GatewayJsonObject]> = [
    ['list_file_areas', { projectId: '1' }],
    ['list_folders', { projectId: '1', fileAreaId: 'a' }],
    ['list_files', { projectId: '1', fileAreaId: 'a' }],
    ['list_version_sets', { projectId: '1' }],
    ['download_file', { projectId: '1', fileAreaId: 'a', fileId: 'f', fileRevisionId: 'r' }],
    ['list_property_mappings', { scope: 'folder', projectId: '1', fileAreaId: 'a', folderId: 'd' }],
    ['list_property_mappings', { scope: 'file', projectId: '1', fileAreaId: 'a', fileId: 'f' }],
  ];

  it.each(boxCalls)('%s fails fast without Box Pro', async (tool, input) => {
    const { gw, fetchImpl } = setup({ [PROJECT]: { body: LIGHT } });
    const result = await gw.callTool(tool, input);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe(
      "The Dalux Build API's Box endpoints require Box Pro; project 1 has Box light. This depends on the project licence in Dalux; retrying will not help.",
    );
    expect(urls(fetchImpl)).toEqual(['GET /5.0/projects/1']);
  });

  it('reports a project without a Box module', async () => {
    const { gw } = setup({ [PROJECT]: { body: FIELD_ONLY } });
    const result = await gw.callTool('list_file_areas', { projectId: '1' });
    expect(result.content[0]?.text).toContain('project 1 has Box not enabled');
  });

  it('refuses uploads without Box Pro after validating the input, before reserving a slot', async () => {
    process.env.DALUX_ENABLE_WRITES = 'true';
    const { gw, fetchImpl } = setup({ [PROJECT]: { body: LIGHT } });
    const result = await gw.callTool('upload_file', {
      projectId: '1',
      fileAreaId: 'a',
      folderId: 'd',
      fileName: 'a.txt',
      contentBase64: Buffer.from('x').toString('base64'),
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('require Box Pro');
    expect(urls(fetchImpl)).toEqual(['GET /5.0/projects/1']);
  });

  it('calls the Box endpoint with Box Pro and caches the module lookup', async () => {
    const { gw, fetchImpl } = setup({
      [PROJECT]: { body: PRO },
      [`${BASE}/5.1/projects/1/file_areas`]: { body: PAGE },
    });
    expect((await gw.callTool('list_file_areas', { projectId: '1' })).isError).toBeFalsy();
    expect((await gw.callTool('list_file_areas', { projectId: '1' })).isError).toBeFalsy();
    expect(urls(fetchImpl)).toEqual([
      'GET /5.0/projects/1',
      'GET /5.1/projects/1/file_areas',
      'GET /5.1/projects/1/file_areas',
    ]);
  });

  it('falls through to the real call when the module lookup fails, and maps E40301', async () => {
    const { gw, fetchImpl } = setup({
      [PROJECT]: { status: 500, body: { message: 'boom' } },
      [`${BASE}/5.1/projects/1/file_areas`]: {
        status: 403,
        body: {
          httpStatusCode: 403,
          errorCode: 'E40301',
          message: 'This call requires the project to have Box Pro enabled',
        },
      },
    });
    const result = await gw.callTool('list_file_areas', { projectId: '1' });
    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('E40301');
    expect(text).toContain('Box Pro');
    expect(text).toMatch(/licence or module/);
    expect(urls(fetchImpl)).toContain('GET /5.1/projects/1/file_areas');
  });

  it('falls through when the project response has no modules', async () => {
    const { gw, fetchImpl } = setup({
      [PROJECT]: { body: { data: { projectId: '1' } } },
      [`${BASE}/5.1/projects/1/file_areas`]: { body: PAGE },
    });
    expect((await gw.callTool('list_file_areas', { projectId: '1' })).isError).toBeFalsy();
    expect(urls(fetchImpl)).toHaveLength(2);
  });
});

describe('Field pre-check', () => {
  const fieldCalls: Array<[string, GatewayJsonObject]> = [
    ['list_tasks', { projectId: '1' }],
    ['get_task', { projectId: '1', taskId: 't' }],
    ['get_task_changes', { projectId: '1' }],
    ['list_task_attachments', { projectId: '1' }],
    ['list_forms', { projectId: '1' }],
    ['get_form', { projectId: '1', formId: 'f' }],
    ['list_form_attachments', { projectId: '1' }],
    ['list_quality_plans', { projectId: '1', kind: 'inspection' }],
  ];

  it.each(fieldCalls)('%s fails fast without the Field module', async (tool, input) => {
    const { gw, fetchImpl } = setup({ [PROJECT]: { body: BOX_ONLY } });
    const result = await gw.callTool(tool, input);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(
      "The Dalux Build API's Field endpoints require the Field module; project 1 does not have Field enabled.",
    );
    expect(urls(fetchImpl)).toEqual(['GET /5.0/projects/1']);
  });

  it('calls the Field endpoint when the project has Field', async () => {
    const { gw } = setup({ [PROJECT]: { body: LIGHT }, [`${BASE}/5.2/projects/1/tasks`]: { body: PAGE } });
    const result = await gw.callTool('list_tasks', { projectId: '1' });
    expect(result.isError).toBeFalsy();
  });
});

describe('read-only restriction on writes', () => {
  const readOnly = {
    data: {
      projectId: '1',
      modules: [
        { type: 'box', tier: 'pro', restriction: 'readOnly' },
        { type: 'field', tier: 'field', restriction: 'readOnly' },
      ],
    },
  };

  it('refuses project updates and project company writes', async () => {
    process.env.DALUX_ENABLE_WRITES = 'true';
    const { gw, fetchImpl } = setup({ [PROJECT]: { body: readOnly } });
    const update = await gw.callTool('change_project', { action: 'update', projectId: '1', patch: { projectName: 'X' } });
    expect(update.isError).toBe(true);
    expect(update.content[0]?.text).toContain('read-only (restriction readOnly)');
    const company = await gw.callTool('change_company', {
      scope: 'project',
      action: 'create',
      projectId: '1',
      body: { name: 'X' },
    });
    expect(company.isError).toBe(true);
    expect(fetchImpl.mock.calls.every(([, init]) => (init?.method ?? 'GET') === 'GET')).toBe(true);
  });

  it('refuses uploads when the Box module is read-only', async () => {
    process.env.DALUX_ENABLE_WRITES = 'true';
    const { gw, fetchImpl } = setup({ [PROJECT]: { body: readOnly } });
    const result = await gw.callTool('upload_file', {
      projectId: '1',
      fileAreaId: 'a',
      folderId: 'd',
      fileName: 'a.txt',
      contentBase64: Buffer.from('x').toString('base64'),
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('box module of project 1');
    expect(urls(fetchImpl)).toEqual(['GET /5.0/projects/1']);
  });

  it('allows a project update when only one module is read-only', async () => {
    process.env.DALUX_ENABLE_WRITES = 'true';
    const partial = {
      data: { projectId: '1', modules: [{ type: 'box', tier: 'pro', restriction: 'readOnly' }, { type: 'field', tier: 'field' }] },
    };
    const { gw } = setup({ [PROJECT]: { body: partial } });
    const result = await gw.callTool('change_project', { action: 'update', projectId: '1', patch: { projectName: 'X' } });
    expect(result.isError).toBeFalsy();
  });
});

describe('dalux_get_project licence summary', () => {
  it('adds a licence summary next to the raw data', async () => {
    const trial = {
      data: { projectId: '1', modules: [{ type: 'box', tier: 'light', restriction: 'trial' }, { type: 'field', tier: 'field' }] },
    };
    const { gw } = setup({ [PROJECT]: { body: trial } });
    const result = await gw.callTool('get_project', { projectId: '1' });
    expect(result.structuredContent).toEqual({
      ...trial,
      licence: { box: 'light', field: 'field', restrictions: ['box:trial'] },
    });
  });

  it('adds it alongside project and metadata with includeMetadata', async () => {
    const { gw } = setup({
      [PROJECT]: { body: LIGHT },
      [`${BASE}/1.0/projects/1/metadata`]: { body: { items: [] } },
    });
    const result = await gw.callTool('get_project', { projectId: '1', includeMetadata: true });
    expect(result.structuredContent).toEqual({
      project: LIGHT,
      metadata: { items: [] },
      licence: { box: 'light', field: 'field', restrictions: [] },
    });
  });

  it('leaves the result unchanged when the project has no modules', async () => {
    const { gw } = setup({ [PROJECT]: { body: { data: { projectId: '1' } } } });
    const result = await gw.callTool('get_project', { projectId: '1' });
    expect(result.structuredContent).toEqual({ data: { projectId: '1' } });
  });

  it('primes the module cache for later Box calls', async () => {
    const { gw, fetchImpl } = setup({ [PROJECT]: { body: LIGHT } });
    await gw.callTool('get_project', { projectId: '1' });
    const result = await gw.callTool('list_file_areas', { projectId: '1' });
    expect(result.isError).toBe(true);
    expect(urls(fetchImpl)).toEqual(['GET /5.0/projects/1']);
  });
});

describe('module cache', () => {
  function client(routes: Record<string, Stub>) {
    const fetchImpl = stubFetch(routes);
    return { client: new DaluxClient({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch }), fetchImpl };
  }

  it('expires entries after the TTL and does not cache failures', async () => {
    const { client: c, fetchImpl } = client({ [PROJECT]: { body: PRO } });
    await getProjectModules(c, '1', 0);
    await getProjectModules(c, '1', MODULE_CACHE_TTL_MS - 1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await getProjectModules(c, '1', MODULE_CACHE_TTL_MS + 1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    expect(await getProjectModules(c, 'missing')).toBeUndefined();
    expect(await getProjectModules(c, 'missing')).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('is bounded and per client', async () => {
    const { client: c, fetchImpl } = client({});
    for (let i = 0; i <= MODULE_CACHE_MAX_ENTRIES; i += 1) {
      rememberProjectModules(c, `p${i}`, PRO);
    }
    // The oldest entry was evicted; the newest is still cached.
    expect(await getProjectModules(c, `p${MODULE_CACHE_MAX_ENTRIES}`)).toEqual(PRO.data.modules);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await getProjectModules(c, 'p0')).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const other = client({});
    expect(await getProjectModules(other.client, `p${MODULE_CACHE_MAX_ENTRIES}`)).toBeUndefined();
    expect(other.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('summarises modules', () => {
    expect(licenceSummary([])).toEqual({ box: null, field: null, restrictions: [] });
    expect(licenceSummary([{ type: 'field', tier: 'basic', restriction: 'sandbox' }])).toEqual({
      box: null,
      field: 'basic',
      restrictions: ['field:sandbox'],
    });
  });
});

describe('dalux_get_task_changes without changes', () => {
  it('returns an empty page for 404 "No task changes on project"', async () => {
    const { gw } = setup({
      [PROJECT]: { body: LIGHT },
      [`${BASE}/2.3/projects/1/tasks/changes`]: {
        status: 404,
        body: { httpStatusCode: 404, errorCode: 'E40401', message: 'No task changes on project' },
      },
    });
    const result = await gw.callTool('get_task_changes', { projectId: '1' });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      items: [],
      pagesFetched: 1,
      endOfIncrementalStream: false,
      note: 'Dalux reports no task changes on this project.',
    });
  });

  it('keeps other 404s as errors', async () => {
    const { gw } = setup({
      [PROJECT]: { body: LIGHT },
      [`${BASE}/2.3/projects/1/tasks/changes`]: {
        status: 404,
        body: { httpStatusCode: 404, errorCode: 'E40401', message: 'Project not found' },
      },
    });
    const result = await gw.callTool('get_task_changes', { projectId: '1' });
    expect(result.isError).toBe(true);
  });

  it('keeps non-404 errors mentioning task changes as errors', async () => {
    const { isNoTaskChanges } = await import('../src/dalux/tasks.js');
    const error = new DaluxHttpError({ status: 400, url: `${BASE}/x`, payload: { message: 'No task changes on project' } });
    expect(isNoTaskChanges(error)).toBe(false);
    expect(isNoTaskChanges(new Error('No task changes on project'))).toBe(false);
  });
});

describe('dalux_list_property_mappings', () => {
  const page = (url: string): Record<string, Stub> => ({ [PROJECT]: { body: PRO }, [`${BASE}${url}`]: { body: PAGE } });

  it.each([
    [{ scope: 'folder', projectId: '1', fileAreaId: 'a', folderId: 'd' }, '/1.1/projects/1/file_areas/a/folders/d/files/properties/1.0/mappings'],
    [{ scope: 'file', projectId: '1', fileAreaId: 'a', fileId: 'f' }, '/1.1/projects/1/file_areas/a/files/f/properties/1.0/mappings'],
    [{ scope: 'file', projectId: '1', fileAreaId: 'a', key: 'p9' }, '/1.0/projects/1/file_areas/a/files/properties/1.0/mappings/p9/values'],
    [{ scope: 'folder', projectId: '1', fileAreaId: 'a', key: 'p9' }, '/1.0/projects/1/file_areas/a/files/properties/1.0/mappings/p9/values'],
    [{ scope: 'project' }, '/1.0/projects/metadata/1.0/mappings'],
    [{ scope: 'project', key: 'k' }, '/1.0/projects/metadata/1.0/mappings/k/values'],
    [{ scope: 'project', projectId: '1' }, '/1.0/projects/1/metadata/1.0/mappings'],
    [{ scope: 'project', projectId: '1', key: 'k' }, '/1.0/projects/1/metadata/1.0/mappings/k/values'],
    [{ scope: 'companyCatalog' }, '/1.0/companyCatalog/metadata/1.0/mappings'],
    [{ scope: 'companyCatalog', key: 'k' }, '/1.0/companyCatalog/metadata/1.0/mappings/k/values'],
    [{ scope: 'companyCatalog', companyId: 'c' }, '/1.0/companyCatalog/c/metadata/1.0/mappings'],
    [{ scope: 'companyCatalog', companyId: 'c', key: 'k' }, '/1.0/companyCatalog/c/metadata/1.0/mappings/k/values'],
  ])('%j -> %s', async (input, path) => {
    const { gw, fetchImpl } = setup(page(path));
    const result = await gw.callTool('list_property_mappings', input);
    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as { items: unknown[] }).items).toEqual(PAGE.items);
    expect(urls(fetchImpl).at(-1)).toBe(`GET ${path}`);
    // Only Box scopes look up the project modules.
    const boxScope = input.scope === 'folder' || input.scope === 'file';
    expect(urls(fetchImpl).includes('GET /5.0/projects/1')).toBe(boxScope);
  });

  it('requires the ids of the chosen scope', async () => {
    const { gw, fetchImpl } = setup({});
    const missingFolder = await gw.callTool('list_property_mappings', { scope: 'folder', projectId: '1', fileAreaId: 'a' });
    expect(missingFolder.isError).toBe(true);
    expect(missingFolder.content[0]?.text).toContain('folderId is required for scope=folder');
    const missingProject = await gw.callTool('list_property_mappings', { scope: 'file', fileAreaId: 'a', fileId: 'f' });
    expect(missingProject.content[0]?.text).toContain('projectId is required for scope=file');
    const traversal = await gw.callTool('list_property_mappings', { scope: 'project', key: '..' });
    expect(traversal.isError).toBe(true);
    expect(urls(fetchImpl).filter(url => !url.includes('/5.0/projects/'))).toEqual([]);
  });
});

describe('includeProperties', () => {
  it('is sent on file lists only when requested', async () => {
    const { gw, fetchImpl } = setup({
      [PROJECT]: { body: PRO },
      [`${BASE}/6.1/projects/1/file_areas/a/files`]: { body: PAGE },
      [`${BASE}/3.0/projects/1/version_sets/v/files`]: { body: PAGE },
    });
    await gw.callTool('list_files', { projectId: '1', fileAreaId: 'a', includeProperties: true });
    await gw.callTool('list_files', { projectId: '1', fileAreaId: 'a' });
    await gw.callTool('list_version_sets', { projectId: '1', versionSetId: 'v', includeFiles: true, includeProperties: true });
    expect(urls(fetchImpl)).toEqual([
      'GET /5.0/projects/1',
      'GET /6.1/projects/1/file_areas/a/files?includeProperties=true',
      'GET /6.1/projects/1/file_areas/a/files',
      'GET /3.0/projects/1/version_sets/v/files?includeProperties=true',
    ]);
  });
});
