// The sink check (README, "Threat model"): nothing that leaves a gateway holds a piece of 6 characters of the key.
// Every output is checked in its final form; the round-7 counterexamples and keys spliced from real outputs. The
// export archive is covered in export.test.ts.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDaluxGateway } from '../src/gateway.js';
import { visibleTexts } from '../src/key-admission.js';
import { BASE } from './helpers.js';

const PROJECT = '100000000000000001';
const originalEnv = { ...process.env };

beforeEach(() => {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('DALUX_')) delete process.env[name];
  }
});

afterEach(() => {
  process.env = { ...originalEnv };
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function pieces(value: string): string[] {
  const out: string[] = [];
  for (let i = 0; i + 6 <= value.length; i += 1) out.push(value.slice(i, i + 6));
  return out;
}

function leaked(key: string, outputs: unknown[]): string[] {
  const texts = outputs.flatMap(output => (typeof output === 'string' ? [output] : visibleTexts(output)));
  return pieces(key).filter(piece => texts.some(text => text.includes(piece)));
}

const upstream = (body: unknown = { data: { taskId: 't1', subject: 'Check the railing', status: 'open', riskLevel: 'low' } }): typeof fetch =>
  async input => {
    const path = (String(input).split('?')[0] ?? '').slice(BASE.length);
    if (path === `/5.0/projects/${PROJECT}`) return json({ data: { projectId: PROJECT, projectName: 'Example build' } });
    if (/\/tasks\/t1$/.test(path)) return json(body);
    return json({ message: 'no stub' }, 404);
  };

async function outputs(apiKey: string): Promise<{ refused?: string; outputs: unknown[] }> {
  const records: unknown[] = [];
  let gw: ReturnType<typeof createDaluxGateway>;
  try {
    gw = createDaluxGateway({
      apiKey,
      baseUrl: BASE,
      fetchImpl: upstream(),
      maxAttempts: 1,
      policy: { licensePrecheck: false, audit: record => void records.push(record) },
    });
  } catch (error) {
    return { refused: (error as Error).message, outputs: [(error as Error).message, (error as Error).name] };
  }
  const results = [
    await gw.callTool('get_task', { projectId: PROJECT, taskId: 't1' }, { caller: 'person@example.test', requestId: 'r1' }),
    await gw.callTool('get_task', { projectId: PROJECT, taskId: 'missing' }),
    await gw.callTool('no_such_tool', {}),
    await gw.callTool('get_task', { unknown: 1 }),
  ];
  return { outputs: [gw.tools, ...results, ...records] };
}

describe('the sink check', () => {
  it('holds for the round-7 counterexamples', async () => {
    for (const apiKey of [
      'Zq7pX2-kind,p-Wb4TnR',
      'riskLevelQz7pX2vK9mWb',
      'Zq7pX2visError9mWb4TnR',
      'qz7":"staV8k2mP9',
      'x"ok":y-0123456789',
      'URI malformedQz7pX2vK9mWb\uD800',
    ]) {
      const { refused, outputs: seen } = await outputs(apiKey);
      if (refused !== undefined) expect(refused, apiKey).toMatch(/key was refused/);
      expect(leaked(apiKey, seen), apiKey).toEqual([]);
    }
  });

  it('refuses a key that is not printable ASCII before anything is built from it', () => {
    for (const apiKey of ['URI malformedQz7pX2vK9mWb\uD800', 'Zq7pX2vK9mWb4TnRé', 'Zq7pX2 vK9mWb4TnR8y']) {
      expect(() => createDaluxGateway({ apiKey, baseUrl: BASE }), apiKey).toThrow(/key was refused/);
    }
    expect(() => createDaluxGateway({ apiKey: 'riskLevelQz7pX2vK9mWb', baseUrl: BASE })).toThrow(/key was refused/);
  });

  it('holds for keys spliced from the outputs of a normal session', async () => {
    const base = await outputs('Zq7pX2vK9mWb4TnR8yLc3HdJ6fGs1QeU');
    expect(base.refused).toBeUndefined();
    const texts = base.outputs.flatMap(output => visibleTexts(output)).filter(text => text.length >= 6);
    let seed = 13;
    const random = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % n;
    };
    const filler = (n: number) => Array.from({ length: n }, () => String.fromCharCode(0x30 + random(43))).join('');
    let admitted = 0;
    for (let round = 0; round < 40; round += 1) {
      const text = texts[random(texts.length)]!;
      const start = random(text.length - 5);
      const window = text.slice(start, start + 6);
      if (!/^[\x21-\x7E]{6}$/.test(window)) continue;
      const apiKey = `${filler(6)}${window}${filler(6)}`;
      const { refused, outputs: seen } = await outputs(apiKey);
      if (refused === undefined) admitted += 1;
      expect(leaked(apiKey, seen), apiKey).toEqual([]);
    }
    expect(admitted).toBeGreaterThan(0);
  });
});

describe('failure texts', () => {
  it('replaces texts in failure lists of a successful answer', async () => {
    const gw = createDaluxGateway({
      apiKey: 'Zq7pX2vK9mWb4TnR8yLc3HdJ6fGs1QeU',
      baseUrl: BASE,
      maxAttempts: 1,
      policy: { licensePrecheck: false },
      fetchImpl: upstream({ data: { failures: ['Vendor diagnostic'], errors: ['Vendor diagnostic'] } }),
    });
    const result = await gw.callTool('get_task', { projectId: PROJECT, taskId: 't1' });
    expect(JSON.stringify(result)).not.toContain('Vendor');
    expect(result.structuredContent).toMatchObject({
      data: { failures: ['Dalux reported a failure.'], errors: ['Dalux reported a failure.'] },
    });
  });
});
