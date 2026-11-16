import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Ajv } from 'ajv';
import { DaluxClient } from '../src/dalux/client.js';
import { createServer } from '../src/server.js';
import { READ_TOOLS, WRITE_TOOLS } from '../src/dalux/policy.js';
import { DALUX_CAPABILITIES, UNTRUSTED_CONTENT_NOTE } from '../src/dalux/capabilities.js';
import { createDaluxGateway, daluxGatewayTools } from '../src/gateway.js';
import { DALUX_TOOLS } from '../src/tools/dalux.js';
import { BASE, auditLines, connect, gateway, texts } from './helpers.js';

const originalEnv = { ...process.env };
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'dalux-hardening-'));
});

afterEach(() => {
  process.env = { ...originalEnv };
  rmSync(tempDir, { recursive: true, force: true });
});

describe('gateway schema contract', () => {
  it('every gateway inputSchema compiles with a default strict Ajv (no format plugins)', () => {
    const ajv = new Ajv();
    for (const tool of daluxGatewayTools) {
      expect(() => ajv.compile(tool.inputSchema), tool.name).not.toThrow();
      expect(JSON.stringify(tool.inputSchema), tool.name).not.toContain('"format"');
    }
  });

  it('ties tool names across DALUX_TOOLS, capabilities and policy', () => {
    const tools = DALUX_TOOLS.map(t => t.name).sort();
    expect(DALUX_CAPABILITIES.map(c => c.id).sort()).toEqual(tools);
    expect([...READ_TOOLS, ...WRITE_TOOLS].sort()).toEqual(tools);
    for (const tool of DALUX_TOOLS) {
      expect(WRITE_TOOLS.has(tool.name)).toBe(!tool.annotations.readOnlyHint);
    }
  });

  it('marks every content-returning tool as untrusted, including downloads', () => {
    for (const tool of DALUX_TOOLS) {
      expect(tool.description.includes(UNTRUSTED_CONTENT_NOTE)).toBe(tool.returnsDaluxContent);
    }
    expect(DALUX_TOOLS.find(t => t.name === 'dalux_download_file')?.description).toContain(UNTRUSTED_CONTENT_NOTE);
  });
});

describe('write payload round trip', () => {
  it('accepts read-only fields from a fetched project and drops them before PATCH', async () => {
    process.env.DALUX_ENABLE_WRITES = 'true';
    const { gw, fetchImpl } = gateway({ [`${BASE}/5.0/projects/1`]: { body: { data: { projectId: '1' } } } });
    const result = await gw.callTool('change_project', {
      action: 'update',
      projectId: '1',
      patch: {
        projectId: '1',
        created: '2026-01-01T00:00:00Z',
        modules: [{ moduleName: 'field' }],
        projectName: 'Renamed',
        metadata: [{ key: 'k1', name: 'Phase', values: [{ reference: { key: 'r1', value: 'Design' } }] }],
      },
    });
    expect(result.isError).toBeFalsy();
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(JSON.parse(String(init?.body))).toEqual({
      projectName: 'Renamed',
      metadata: [{ key: 'k1', values: [{ reference: { key: 'r1' } }] }],
    });
  });

  it('accepts metadata entries without values, as the spec allows', async () => {
    process.env.DALUX_ENABLE_WRITES = 'true';
    const { gw, fetchImpl } = gateway({ [`${BASE}/5.0/projects/1`]: { body: {} } });
    const result = await gw.callTool('change_project', {
      action: 'update',
      projectId: '1',
      patch: { metadata: [{ key: 'k1' }] },
    });
    expect(result.isError).toBeFalsy();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects an update with no writable fields', async () => {
    process.env.DALUX_ENABLE_WRITES = 'true';
    const { gw, fetchImpl } = gateway();
    const empty = await gw.callTool('change_project', { action: 'update', projectId: '1', patch: {} });
    expect(empty.isError).toBe(true);
    expect(empty.content[0]?.text).toContain('no writable fields');
    const onlyReadOnly = await gw.callTool('change_project', {
      action: 'update',
      projectId: '1',
      patch: { projectId: '1' },
    });
    expect(onlyReadOnly.isError).toBe(true);
    const company = await gw.callTool('change_company', {
      scope: 'catalog',
      action: 'update',
      companyId: '9',
      body: {},
    });
    expect(company.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('names the offending key in change_company validation errors', async () => {
    process.env.DALUX_ENABLE_WRITES = 'true';
    const { mcpClient, fetchImpl } = await connect();
    const typo = await mcpClient.callTool({
      name: 'dalux_change_company',
      arguments: { scope: 'catalog', action: 'create', body: { nmae: 'X' } },
    });
    expect(typo.isError).toBe(true);
    expect(texts(typo)[0]).toContain('nmae');

    const wrongScope = await mcpClient.callTool({
      name: 'dalux_change_company',
      arguments: { scope: 'project', action: 'create', projectId: '1', body: { website: 'https://example.com' } },
    });
    expect(wrongScope.isError).toBe(true);
    expect(texts(wrongScope)[0]).toContain('website');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects unknown top-level arguments on the MCP path', async () => {
    const { mcpClient, fetchImpl } = await connect();
    const result = await mcpClient.callTool({ name: 'dalux_list_tasks', arguments: { projectId: '1', typeID: 'x' } });
    expect(result.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('project allowlist coverage', () => {
  it('filters dalux_list_projects to allowed projects and drops account-wide totals', async () => {
    process.env.DALUX_ALLOWED_PROJECT_IDS = '1';
    const { mcpClient } = await connect({
      [`${BASE}/5.1/projects`]: {
        body: {
          items: [{ data: { projectId: '1', projectName: 'A' } }, { data: { projectId: '2', projectName: 'Hidden' } }],
          metadata: { totalItems: 2, totalRemainingItems: 2 },
        },
      },
    });
    const result = await mcpClient.callTool({ name: 'dalux_list_projects', arguments: {} });
    const json = JSON.parse(texts(result)[0] ?? '');
    expect(json.items).toEqual([{ data: { projectId: '1', projectName: 'A' } }]);
    expect(json.totalItems).toBeUndefined();
    expect(texts(result)[0]).not.toContain('Hidden');
  });

  it('refuses project creation while an allowlist is set, unless explicitly allowed', async () => {
    process.env.DALUX_ENABLE_WRITES = 'true';
    process.env.DALUX_ALLOWED_PROJECT_IDS = '1';
    const { gw, fetchImpl } = gateway({ [`${BASE}/5.0/projects`]: { body: { data: { projectId: 'new' } } } });
    const input = { action: 'create', adminEmail: 'admin@example.com', body: { projectName: 'X' } };

    const denied = await gw.callTool('change_project', input);
    expect(denied.isError).toBe(true);
    expect(denied.content[0]?.text).toContain('DALUX_ALLOW_PROJECT_CREATE');
    expect(fetchImpl).not.toHaveBeenCalled();

    process.env.DALUX_ALLOW_PROJECT_CREATE = 'true';
    const allowed = await gw.callTool('change_project', input);
    expect(allowed.isError).toBeFalsy();
  });

  it('compares the project in a pageLink case-sensitively', async () => {
    process.env.DALUX_ALLOWED_PROJECT_IDS = 'abc';
    const { gw, fetchImpl } = gateway();
    const result = await gw.callTool('list_tasks', {
      projectId: 'abc',
      pageLink: `${BASE}/5.2/projects/ABC/tasks?bookmark=2`,
    });
    expect(result.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('treats a blank-only allowlist as a startup error, an empty value as unset', () => {
    process.env.DALUX_ALLOWED_PROJECT_IDS = ' , ';
    expect(() => createServer({ client: new DaluxClient({ apiKey: 'k' }) })).toThrow('DALUX_ALLOWED_PROJECT_IDS');
    expect(() => createDaluxGateway({ apiKey: 'k' })).toThrow('DALUX_ALLOWED_PROJECT_IDS');
    process.env.DALUX_ALLOWED_PROJECT_IDS = '';
    expect(() => createDaluxGateway({ apiKey: 'k' })).not.toThrow();
  });
});

describe('disabled tools', () => {
  it('are hidden from tools/list, gateway tools and capability search', async () => {
    process.env.DALUX_DISABLED_TOOLS = 'upload_file,dalux_list_project_users';
    const { mcpClient } = await connect();
    const { tools } = await mcpClient.listTools();
    expect(tools.map(t => t.name)).not.toContain('dalux_upload_file');
    expect(tools.map(t => t.name)).not.toContain('dalux_list_project_users');

    const { gw } = gateway();
    expect(gw.tools.map(t => t.name)).not.toContain('upload_file');
    expect(gw.tools.map(t => t.name)).toContain('list_tasks');

    const found = await mcpClient.callTool({ name: 'dalux_search_capabilities', arguments: { query: 'upload users' } });
    expect(texts(found)[0]).not.toContain('dalux_upload_file');
    expect(texts(found)[0]).not.toContain('dalux_list_project_users');
  });

  it('reject unknown names at startup', () => {
    process.env.DALUX_DISABLED_TOOLS = 'list_taks';
    expect(() => createDaluxGateway({ apiKey: 'k' })).toThrow('list_taks');
  });
});

describe('gateway robustness and rejected-call audit', () => {
  it('returns error results for malformed context and tool names instead of throwing', async () => {
    const { gw } = gateway({ [`${BASE}/3.4/projects/1/tasks/2`]: { body: { data: {} } } });
    await expect(gw.callTool('get_task', { projectId: '1', taskId: '2' }, null as never)).resolves.toMatchObject({
      structuredContent: { data: {} },
    });
    const odd = await gw.callTool('get_task', { projectId: '1', taskId: '2' }, { requestId: 42, caller: {} } as never);
    expect(odd.isError).toBeFalsy();
    await expect(gw.callTool(42 as never, {})).resolves.toMatchObject({ isError: true });
    await expect(gw.callTool('get_task', null as never)).resolves.toMatchObject({ isError: true });
  });

  it('audits unknown tools and invalid input with field names only', async () => {
    const auditPath = join(tempDir, 'audit.jsonl');
    process.env.DALUX_AUDIT_LOG = auditPath;
    const { gw } = gateway();
    await gw.callTool('delete_everything', { secret: 'value-1' }, { caller: 'u1' });
    await gw.callTool('get_task', { projectId: '1', note: 'value-2' });

    const lines = auditLines(auditPath);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      action: 'rejected',
      tool: 'delete_everything',
      caller: 'u1',
      target: { fields: ['secret'] },
    });
    expect(lines[1]).toMatchObject({
      action: 'rejected',
      tool: 'dalux_get_task',
      target: { fields: ['note', 'projectId'] },
    });
    expect(readFileSync(auditPath, 'utf8')).not.toMatch(/value-[12]/);
  });
});

describe('audit hardening', () => {
  it('fails closed for write tools when the start event cannot be written', async () => {
    process.env.DALUX_ENABLE_WRITES = 'true';
    process.env.DALUX_AUDIT_LOG = tempDir; // a directory: appendFile fails
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { gw, fetchImpl } = gateway({ [`${BASE}/5.0/projects/1`]: { body: {} } });

    const result = await gw.callTool('change_project', {
      action: 'update',
      projectId: '1',
      patch: { projectName: 'X' },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Audit log is not writable');
    expect(fetchImpl).not.toHaveBeenCalled();
    stderr.mockRestore();
  });

  it('logs status, error code and a short message, never the response text or the admin e-mail', async () => {
    process.env.DALUX_ENABLE_WRITES = 'true';
    const auditPath = join(tempDir, 'audit.jsonl');
    process.env.DALUX_AUDIT_LOG = auditPath;
    const { gw } = gateway({
      [`${BASE}/5.0/projects`]: {
        status: 400,
        raw: 'User jane.doe@example.com is not a Dalux user; projectName "Secret Tower"',
      },
      [`${BASE}/5.0/projects/1`]: {
        status: 409,
        body: { errorCode: 'E40901', message: 'Project "Secret Tower" locked' },
      },
    });

    await gw.callTool('change_project', {
      action: 'create',
      adminEmail: 'jane.doe@example.com',
      body: { projectName: 'Secret Tower' },
    });
    await gw.callTool('change_project', { action: 'update', projectId: '1', patch: { projectName: 'Secret Tower' } });

    const log = readFileSync(auditPath, 'utf8');
    expect(log).not.toContain('jane.doe');
    expect(log).not.toContain('Secret Tower');
    const errors = auditLines(auditPath).filter(line => line.action === 'error');
    expect(errors[0]).toMatchObject({ httpStatus: 400, target: { adminEmailDomain: 'example.com' } });
    expect(errors[1]).toMatchObject({ httpStatus: 409, errorCode: 'E40901' });
    for (const line of errors) {
      expect(String(line.error).length).toBeLessThanOrEqual(201);
    }
  });
});
