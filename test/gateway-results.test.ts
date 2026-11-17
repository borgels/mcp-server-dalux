// One property, proved through every channel at once: no piece of an instance's key (six characters or more)
// reaches a host result, a thrown error or an audit record. The key has a quote and a backslash, so a form that
// is serialised before it is redacted would show; Dalux echoes the key whole, in fragments, in object keys, in
// error bodies and codes, in a redirect's Location, in an over-limit body and in a failed part of a combined read;
// the environment holds it where a number or a switch was expected.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FRAGMENT_LENGTH, MAX_REDACT_DEPTH, redactDeep, SecretRedactor } from '../src/errors.js';
import { createDaluxGateway, type GatewayToolResult } from '../src/gateway.js';
import { BASE } from './helpers.js';

const KEY = `tenant"a\\kEy-${'Q7'.repeat(10)}-ZZtop-0123456789`;
const FRAGMENT = KEY.slice(0, 12);
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

function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach(entry => strings(entry, out));
  else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      out.push(key);
      strings(entry, out);
    }
  }
  return out;
}

/** The pieces of the key found anywhere in `value`, raw or serialised. */
function leaks(value: unknown): string[] {
  const texts = [...strings(value), JSON.stringify(value) ?? ''];
  const found = new Set<string>();
  for (let i = 0; i + FRAGMENT_LENGTH <= KEY.length; i += 1) {
    const piece = KEY.slice(i, i + FRAGMENT_LENGTH);
    if (texts.some(text => text.includes(piece))) found.add(piece);
  }
  return [...found];
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** Dalux: each task id answers through one channel. */
const upstream: typeof fetch = async input => {
  const url = String(input).split('?')[0] ?? '';
  const path = url.slice(BASE.length);
  const task = /\/tasks\/([^/]+)$/.exec(path)?.[1];
  if (path === `/5.0/projects/${PROJECT}`) {
    return json({ data: { projectId: PROJECT, projectName: KEY, [KEY]: FRAGMENT, nested: { [`k ${FRAGMENT}`]: [KEY] } } });
  }
  if (path === `/1.0/projects/${PROJECT}/metadata`) {
    return json({ message: `Rejected credential prefix: ${FRAGMENT}`, errorCode: FRAGMENT }, 401);
  }
  switch (task) {
    case 'echo':
      return json({ data: { taskId: 'echo', subject: KEY, [KEY]: FRAGMENT } });
    case 'error':
      return json({ message: `Rejected ${KEY}`, errorCode: FRAGMENT, developerHint: KEY, errors: [{ propertyName: KEY }] }, 400);
    case 'code':
      return json({ errorCode: FRAGMENT, code: FRAGMENT }, 401);
    case 'big-error':
      return new Response(`${' '.repeat(70_000)}${KEY}`, { status: 500, headers: { 'content-type': 'text/plain' } });
    case 'redirect':
      return new Response(null, { status: 302, headers: { location: `https://elsewhere.test/${FRAGMENT}?k=${KEY}` } });
    case 'network':
      throw new TypeError(`fetch failed for ${KEY}`, { cause: Object.assign(new Error(`connect ${FRAGMENT}`), { code: FRAGMENT }) });
    default:
      return json({ message: `no stub ${KEY}` }, 404);
  }
};

describe('no piece of the key leaves an instance', () => {
  it('holds for every channel: results, errors, nested failures and audit records', async () => {
    const records: unknown[] = [];
    const gw = createDaluxGateway({
      apiKey: KEY,
      baseUrl: BASE,
      fetchImpl: upstream,
      maxAttempts: 1,
      policy: { audit: record => void records.push(record) },
    });
    const results: GatewayToolResult[] = [];
    for (const taskId of ['echo', 'error', 'code', 'big-error', 'redirect', 'network', 'missing']) {
      results.push(await gw.callTool('get_task', { projectId: PROJECT, taskId }, { caller: `caller ${KEY}`, requestId: FRAGMENT }));
    }
    const combined = await gw.callTool('get_project', { projectId: PROJECT, includeMetadata: true });
    results.push(combined);
    results.push(await gw.callTool(`get_task ${KEY}`, {}), await gw.callTool('get_task', { projectId: PROJECT, taskId: 'x', [KEY]: 1 }));

    expect(results[0]?.isError).toBeUndefined();
    expect(combined.isError).toBeUndefined();
    expect(combined.structuredContent).toMatchObject({ metadata: { error: 'Dalux API request failed with HTTP 401' } });
    expect(records.length).toBeGreaterThan(10);
    expect(leaks(results)).toEqual([]);
    expect(leaks(records)).toEqual([]);
  });

  it('holds for errors about the environment', async () => {
    const answers: unknown[] = [];
    for (const name of ['DALUX_ENABLE_WRITES', 'DALUX_DISABLED_TOOLS', 'DALUX_TIMEOUT_MS', 'DALUX_MAX_CONCURRENCY', 'DALUX_ALLOWED_PROJECT_IDS']) {
      process.env[name] = KEY;
      try {
        // Without a host policy the environment applies: the bad value fails at creation or at the call.
        const gw = createDaluxGateway({ apiKey: KEY, baseUrl: BASE, fetchImpl: upstream });
        answers.push(await gw.callTool('get_task', { projectId: PROJECT, taskId: 'echo' }));
      } catch (error) {
        answers.push((error as Error).message);
      }
      delete process.env[name];
    }
    expect(leaks(answers)).toEqual([]);
  });
});

describe('redactDeep', () => {
  it('replaces anything deeper than its limit, strings included, and redacts what is above it', () => {
    const redactor = new SecretRedactor().addSecret(KEY);
    let value: unknown = KEY;
    for (let i = 0; i < MAX_REDACT_DEPTH; i += 1) value = [value];
    // The string sits at depth MAX_REDACT_DEPTH: redacted, not replaced.
    expect(JSON.stringify(redactDeep(value, redactor))).toContain('[REDACTED]');
    expect(JSON.stringify(redactDeep([value], redactor))).toContain('[nested too deep]');
    expect(leaks(redactDeep([value], redactor))).toEqual([]);
  });
});
