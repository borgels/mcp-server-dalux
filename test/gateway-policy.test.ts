import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  allowedProjectIds,
  checkInputPolicy,
  checkToolPolicy,
  licensePrecheckEnabled,
  resolveInstancePolicy,
  runInCallScope,
} from '../src/dalux/policy.js';
import { createDaluxGateway } from '../src/gateway.js';
import { BASE, stubFetch, texts } from './helpers.js';

const originalEnv = { ...process.env };
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dalux-policy-'));
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

const KEY = `tenant-${'x'.repeat(12)}`;

const POLICY_VARIABLES = [
  'DALUX_ENABLE_WRITES',
  'DALUX_DISABLED_TOOLS',
  'DALUX_ALLOWED_PROJECT_IDS',
  'DALUX_ALLOW_PROJECT_CREATE',
  'DALUX_ALLOWED_ADMIN_EMAIL_DOMAINS',
  'DALUX_LICENSE_PRECHECK',
  'DALUX_AUDIT_LOG',
  'DALUX_ALLOW_CUSTOM_BASE_URL',
  'DALUX_EXPORT_DELIVERY',
];

function taskFetch() {
  return stubFetch({
    [`${BASE}/3.4/projects/p1/tasks/t1`]: { body: { data: { taskId: 't1' } } },
    [`${BASE}/3.4/projects/p2/tasks/t1`]: { body: { data: { taskId: 't1' } } },
  });
}

/** Records every environment variable read while `work` runs. */
async function envReads(work: () => Promise<void>): Promise<Set<string>> {
  const reads = new Set<string>();
  const env = { ...process.env };
  process.env = new Proxy(env, {
    get(target, property, receiver) {
      if (typeof property === 'string') {
        reads.add(property);
      }
      return Reflect.get(target, property, receiver);
    },
  });
  try {
    await work();
  } finally {
    process.env = env;
  }
  return reads;
}

describe('instance policy from the host', () => {
  it('reads no policy or audit variable from the environment', async () => {
    process.env.DALUX_ENABLE_WRITES = 'true';
    process.env.DALUX_DISABLED_TOOLS = 'get_task';
    process.env.DALUX_ALLOWED_PROJECT_IDS = 'p9';
    process.env.DALUX_AUDIT_LOG = join(dir, 'audit.jsonl');
    process.env.DALUX_EXPORT_DELIVERY = 'file';

    const reads = await envReads(async () => {
      const gw = createDaluxGateway({ apiKey: KEY, baseUrl: BASE, fetchImpl: taskFetch() as unknown as typeof fetch, policy: {} });
      expect(gw.tools.map(tool => tool.name)).toContain('get_task');
      const result = await gw.callTool('get_task', { projectId: 'p1', taskId: 't1' });
      expect(result.isError).toBeUndefined();
    });

    for (const name of POLICY_VARIABLES) {
      expect(reads.has(name), name).toBe(false);
    }
    expect(existsSync(join(dir, 'audit.jsonl'))).toBe(false);
  });

  it('applies the host policy, not the environment, inside a call', () => {
    process.env.DALUX_ENABLE_WRITES = 'true';
    process.env.DALUX_LICENSE_PRECHECK = 'false';
    const policy = resolveInstancePolicy({ allowedProjectIds: ['p1'] });
    runInCallScope({ policy }, () => {
      expect(checkToolPolicy('dalux_upload_file').allowed).toBe(false);
      expect(checkToolPolicy('dalux_get_task').allowed).toBe(true);
      expect(licensePrecheckEnabled()).toBe(true);
      expect([...(allowedProjectIds() ?? [])]).toEqual(['p1']);
      expect(checkInputPolicy('dalux_get_task', { projectId: 'p2' }).allowed).toBe(false);
      expect(checkInputPolicy('dalux_change_project', { action: 'create' }).allowed).toBe(false);
    });
    // Outside a call the environment still applies.
    expect(checkToolPolicy('dalux_upload_file').allowed).toBe(true);
  });

  it('keeps two instances in one process apart', async () => {
    const fetchImpl = taskFetch() as unknown as typeof fetch;
    const a = createDaluxGateway({ apiKey: KEY, baseUrl: BASE, fetchImpl, policy: { allowedProjectIds: ['p1'] } });
    const b = createDaluxGateway({ apiKey: KEY, baseUrl: BASE, fetchImpl, policy: { disabledTools: ['get_task'] } });

    expect(a.tools.map(tool => tool.name)).toContain('get_task');
    expect(b.tools.map(tool => tool.name)).not.toContain('get_task');

    const [inside, outside, disabled] = await Promise.all([
      a.callTool('get_task', { projectId: 'p1', taskId: 't1' }),
      a.callTool('get_task', { projectId: 'p2', taskId: 't1' }),
      b.callTool('get_task', { projectId: 'p1', taskId: 't1' }),
    ]);
    expect(inside.isError).toBeUndefined();
    expect(outside.isError).toBe(true);
    expect(disabled.isError).toBe(true);
    expect(texts(disabled).join(' ')).toMatch(/disabled on this instance/);
  });

  it('sends audit records to the host', async () => {
    const records: Array<Record<string, unknown>> = [];
    const gw = createDaluxGateway({
      apiKey: KEY,
      baseUrl: BASE,
      fetchImpl: taskFetch() as unknown as typeof fetch,
      policy: { audit: record => void records.push({ ...record }) },
    });
    await gw.callTool('get_task', { projectId: 'p1', taskId: 't1' }, { requestId: 'r1', caller: 'person-1' });
    expect(records.map(r => [r.requestId, r.action, r.caller])).toEqual([
      ['r1', 'start', 'person-1'],
      ['r1', 'finish', 'person-1'],
    ]);
    expect(JSON.stringify(records)).not.toContain(KEY);
  });

  it('refuses an export without a delivery hook under a host policy, naming the host', async () => {
    process.env.DALUX_EXPORT_DELIVERY = 'file';
    process.env.DALUX_EXPORT_DIR = dir;
    const gw = createDaluxGateway({ apiKey: KEY, baseUrl: BASE, fetchImpl: taskFetch() as unknown as typeof fetch, policy: {} });
    const result = await gw.callTool('export_quality_plans', { projectId: 'p1' });
    expect(result.isError).toBe(true);
    const text = texts(result).join(' ');
    expect(text).toMatch(/embedding host has not given a way to deliver/);
    expect(text).not.toMatch(/DALUX_/);
  });

  it('never reads the delivery settings when the host gives policy and a delivery hook', async () => {
    // An invalid value would throw if it were read.
    process.env.DALUX_EXPORT_DELIVERY = 'invalid';
    process.env.DALUX_PUBLIC_BASE_URL = 'not a url';
    process.env.DALUX_EXPORT_DIR = dir;
    const reads = await envReads(async () => {
      const gw = createDaluxGateway({
        apiKey: KEY,
        baseUrl: BASE,
        fetchImpl: taskFetch() as unknown as typeof fetch,
        policy: {},
        exportDelivery: async file => ({ delivery: 'host', name: file.fileName }),
      });
      const result = await gw.callTool('export_quality_plans', { projectId: 'p1' });
      // Whatever Dalux answers here, the call must not fail on the delivery settings.
      expect(texts(result).join(' ')).not.toMatch(/DALUX_EXPORT_DELIVERY|DALUX_PUBLIC_BASE_URL/);
    });
    expect(reads.has('DALUX_EXPORT_DELIVERY')).toBe(false);
    expect(reads.has('DALUX_PUBLIC_BASE_URL')).toBe(false);
  });

  it('rejects an unclear policy when the instance is created', () => {
    const create = (policy: unknown) => () => createDaluxGateway({ apiKey: KEY, baseUrl: BASE, policy: policy as never });
    expect(create({ disabledTools: ['no_such_tool'] })).toThrow(/unknown tool/);
    expect(create({ allowedProjectIds: [] })).toThrow(/empty/);
    expect(create({ allowedProjectIds: [' '] })).toThrow(/empty/);
    expect(create({ enableWrites: 'yes' })).toThrow(/enableWrites/);
    expect(create({ audit: 'file.jsonl' })).toThrow(/audit/);
    expect(create(null)).toThrow(/policy/);
  });
});
