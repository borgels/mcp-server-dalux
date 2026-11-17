// The rest of the threat model (README, "Threat model"), through callTool: a key that is a number and pieces of it in
// numbers, an error while reading a successful body (also inside a combined read), a download whose bytes hold the
// key, and a result too deep to serialise naively. Every result must still be valid JSON. The export archive and its
// delivery hook are covered in export.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DOWNLOAD_REFUSED } from '../src/dalux/box.js';
import { FRAGMENT_LENGTH } from '../src/errors.js';
import { createDaluxGateway } from '../src/gateway.js';
import { BASE } from './helpers.js';

const LEAKY = `tenant"a\\kEy-${'Q7'.repeat(10)}-ZZtop-0123456789`;
const PROJECT = '100000000000000001';
const FILE = `/2.0/projects/${PROJECT}/file_areas/a1/files/f1/revisions/r1/content`;
const DEEP = 20_000;
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

const failingBody = (message: string) =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"data":'));
        controller.error(new Error(message));
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

const bytes = (text: string, type = 'application/octet-stream') =>
  new Response(Buffer.concat([Buffer.from([0, 1, 2, 255]), Buffer.from(text, 'latin1'), Buffer.from([0, 9])]), {
    status: 200,
    headers: { 'content-type': type },
  });

function pieces(value: string): string[] {
  const out: string[] = [];
  for (let i = 0; i + FRAGMENT_LENGTH <= value.length; i += 1) out.push(value.slice(i, i + FRAGMENT_LENGTH));
  return out;
}

function stub(value: string): typeof fetch {
  return async input => {
    const path = (String(input).split('?')[0] ?? '').slice(BASE.length);
    const task = /\/tasks\/([^/]+)$/.exec(path)?.[1];
    if (path === `/5.0/projects/${PROJECT}`) return json({ data: { projectId: PROJECT, projectName: 'Example build' } });
    if (path === `/1.0/projects/${PROJECT}/metadata`) return failingBody(`Vendor diagnostic ${value.slice(0, 5)}`);
    if (path === FILE) return bytes(`header ${value} trailer`);
    if (path === `${FILE.replace('f1', 'f2')}`) return bytes(`piece ${value.slice(3, 3 + FRAGMENT_LENGTH)} only`);
    if (path === `${FILE.replace('f1', 'f3')}`) return bytes('plain content', 'text/plain');
    switch (task) {
      case 'numbers':
        return json({ data: { taskId: 'numbers', echo: Number(value), nested: { n: [Number(value.slice(1, 7)), Number(`${value}9`)] }, ok: true, count: 3 } });
      case 'body-fails':
        return failingBody(`Vendor diagnostic ${value.slice(0, 5)}`);
      case 'deep':
        return new Response(`{"data":${'['.repeat(DEEP)}1${']'.repeat(DEEP)}}`, { status: 200, headers: { 'content-type': 'application/json' } });
      default:
        return json({ message: 'no stub' }, 404);
    }
  };
}

function gateway(value: string, records: unknown[] = []) {
  return createDaluxGateway({
    apiKey: value,
    baseUrl: BASE,
    fetchImpl: stub(value),
    maxAttempts: 1,
    policy: { licensePrecheck: false, audit: record => void records.push(record) },
  });
}

describe('the threat model, through callTool', () => {
  it('redacts a numeric key and its pieces in numbers, and the result stays valid JSON', async () => {
    const NUMERIC = '1234567890123456';
    const records: unknown[] = [];
    const result = await gateway(NUMERIC, records).callTool('get_task', { projectId: PROJECT, taskId: 'numbers' });
    expect(result.isError, JSON.stringify(result.content)).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ data: { echo: '‹redacted›', nested: { n: ['‹redacted›', '‹redacted›'] }, ok: true, count: 3 } });
    const serialised = JSON.stringify(result);
    expect(JSON.parse(serialised)).toEqual(result);
    expect(serialised).not.toMatch(/234567|12345678/);
    expect(JSON.stringify(records)).not.toMatch(/234567|12345678/);
  });

  it('turns an error while reading a successful body into a fixed text, also inside a combined read', async () => {
    const records: unknown[] = [];
    const gw = gateway(LEAKY, records);
    const failed = await gw.callTool('get_task', { projectId: PROJECT, taskId: 'body-fails' });
    expect(failed.isError).toBe(true);
    expect(failed.content[0]?.text).toContain('The Dalux response could not be read.');
    const combined = await gw.callTool('get_project', { projectId: PROJECT, includeMetadata: true });
    expect(combined.isError).toBeUndefined();
    expect(combined.structuredContent).toMatchObject({ metadata: { error: 'The Dalux response could not be read.' } });
    for (const value of [failed, combined, records]) {
      expect(JSON.stringify(value)).not.toContain('Vendor');
      expect(JSON.stringify(value)).not.toContain(JSON.stringify(LEAKY.slice(0, 5)).slice(1, -1));
    }
  });

  it('refuses a download whose bytes hold the key or a piece of it, before base64 encoding', async () => {
    const records: unknown[] = [];
    const gw = gateway(LEAKY, records);
    const results = [];
    for (const fileId of ['f1', 'f2']) {
      const result = await gw.callTool('download_file', { projectId: PROJECT, fileAreaId: 'a1', fileId, fileRevisionId: 'r1' });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain(DOWNLOAD_REFUSED);
      results.push(result);
    }
    const plain = await gw.callTool('download_file', { projectId: PROJECT, fileAreaId: 'a1', fileId: 'f3', fileRevisionId: 'r1' });
    expect(plain.isError).toBeUndefined();
    const text = JSON.stringify([...results, records]);
    for (const piece of pieces(LEAKY)) expect(text).not.toContain(piece);
    // Nor in any base64 form of the key's bytes.
    expect(text).not.toContain(Buffer.from(LEAKY, 'latin1').toString('base64').slice(0, 12));
  });

  it('answers a very deep result without exhausting the stack', async () => {
    const result = await gateway(LEAKY).callTool('get_task', { projectId: PROJECT, taskId: 'deep' });
    expect(result.isError, JSON.stringify(result.content)).toBeUndefined();
    expect(JSON.stringify(result)).toContain('[nested too deep]');
  });
});

describe('round 5 of the threat model, through callTool', () => {
  it('refuses a key that overlaps the redaction marker, and redacts one that looks like the old marker', async () => {
    for (const apiKey of ['‹redacted›-0123456789', 'my-redacted-value', 'xx-dacted›-yy']) {
      expect(() => createDaluxGateway({ apiKey, baseUrl: BASE }), apiKey).toThrow(/key was refused/);
    }
    const LOOKALIKE = '[REDACTED]-0123456789';
    const records: unknown[] = [];
    const gw = createDaluxGateway({
      apiKey: LOOKALIKE,
      baseUrl: BASE,
      maxAttempts: 1,
      fetchImpl: async () => json({ data: { taskId: 't1', subject: LOOKALIKE, [LOOKALIKE]: 1 } }),
      policy: { audit: record => void records.push(record) },
    });
    const result = await gw.callTool('get_task', { projectId: PROJECT, taskId: 't1' }, { caller: LOOKALIKE });
    const text = JSON.stringify([result, records]);
    for (const piece of pieces(LOOKALIKE)) expect(text, piece).not.toContain(piece);
  });

  it('gives the status alone when the body of a failed response cannot be read', async () => {
    const records: unknown[] = [];
    const gw = createDaluxGateway({
      apiKey: LEAKY,
      baseUrl: BASE,
      maxAttempts: 1,
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error(`Vendor diagnostic ${LEAKY.slice(0, 5)}`));
            },
          }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        ),
      policy: { licensePrecheck: false, audit: record => void records.push(record) },
    });
    const result = await gw.callTool('get_task', { projectId: PROJECT, taskId: 't1' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/^Dalux API request failed with HTTP 401/);
    expect(JSON.stringify([result, records])).not.toContain('Vendor');
  });

  it('redacts an audit sink failure before it reaches stderr', async () => {
    const written: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(chunk => {
      written.push(String(chunk));
      return true;
    });
    try {
      const gw = createDaluxGateway({
        apiKey: LEAKY,
        baseUrl: BASE,
        maxAttempts: 1,
        fetchImpl: async () => json({ data: { taskId: 't1' } }),
        policy: {
          audit: () => {
            throw new Error(`sink failed for ${LEAKY}`);
          },
        },
      });
      await gw.callTool('get_task', { projectId: PROJECT, taskId: 't1' });
      await gw.callTool('no_such_tool', {});
    } finally {
      spy.mockRestore();
    }
    const text = written.join('');
    expect(text).toContain('audit log write failed');
    for (const piece of pieces(LEAKY)) expect(text, piece).not.toContain(piece);
  });
});

describe('round 6 of the threat model', () => {
  it('refuses keys that collide with our own texts, without repeating them', () => {
    for (const apiKey of ['[nested too deep]-0123456789', 'dalux-mcp-0123456789', 'DALUX_BASE_URL-0123456789']) {
      let message = '';
      try {
        createDaluxGateway({ apiKey, baseUrl: BASE });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message, apiKey).toMatch(/key was refused/);
      for (const piece of pieces(apiKey)) expect(message, piece).not.toContain(piece);
    }
  });

  it('sends a construction error through the redactor, configuration values included', () => {
    const HOSTLIKE = 'qz7hn4vb8lw2jx6pz9';
    let message = '';
    try {
      createDaluxGateway({ apiKey: HOSTLIKE, baseUrl: `http://${HOSTLIKE}.vendor.invalid/x?y=${HOSTLIKE}` });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toBe('');
    for (const piece of pieces(HOSTLIKE)) expect(message, piece).not.toContain(piece);
  });

  it('reduces failures without an error field, by status or in a failure context', async () => {
    const gw = createDaluxGateway({
      apiKey: LEAKY,
      baseUrl: BASE,
      maxAttempts: 1,
      policy: { licensePrecheck: false },
      fetchImpl: async () =>
        json({
          data: {
            taskId: 't1',
            failures: [{ status: 403, message: 'Vendor diagnostic' }],
            metadata: { status: 401, error: null, message: 'Vendor diagnostic' },
            errors: [{ message: 'Vendor diagnostic' }],
            rows: [{ status: 200, message: 'kept' }],
          },
        }),
    });
    const result = await gw.callTool('get_task', { projectId: PROJECT, taskId: 't1' });
    expect(result.isError, JSON.stringify(result.content)).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      data: {
        failures: [{ status: 403, error: 'Dalux reported a failure with HTTP 403.' }],
        metadata: { status: 401, error: 'Dalux reported a failure with HTTP 401.' },
        errors: [{ error: 'Dalux reported a failure.' }],
        rows: [{ status: 200, message: 'kept' }],
      },
    });
    expect(JSON.stringify(result)).not.toContain('Vendor');
  });
});
