// What a gateway instance returns: the whole result redacted with its key, and failures kept inside a successful
// result (a part that could not be read) as a fixed text with the status, never with Dalux's own words.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDaluxGateway } from '../src/gateway.js';
import { BASE, stubFetch } from './helpers.js';

const KEY = `tenant-a-${'k'.repeat(24)}`;
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

function gatewayFor(routes: Parameters<typeof stubFetch>[0]) {
  const fetchImpl = stubFetch(routes) as unknown as typeof fetch;
  return createDaluxGateway({ apiKey: KEY, baseUrl: BASE, fetchImpl, policy: {} });
}

describe('gateway results', () => {
  it('keeps a failed metadata read in get_project as the status only, without Dalux words or part of the key', async () => {
    const gw = gatewayFor({
      [`${BASE}/5.0/projects/${PROJECT}`]: { body: { data: { projectId: PROJECT, projectName: 'Demo' } } },
      [`${BASE}/1.0/projects/${PROJECT}/metadata`]: {
        status: 401,
        body: { message: `Rejected credential prefix: ${KEY.slice(0, 12)}`, errorCode: 'AUTH' },
      },
    });

    const result = await gw.callTool('get_project', { projectId: PROJECT, includeMetadata: true });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ metadata: { error: 'Dalux API request failed with HTTP 401' } });
    const all = JSON.stringify(result);
    for (const piece of [KEY, KEY.slice(0, 12), 'Rejected credential']) expect(all).not.toContain(piece);
  });

  it('redacts the key from a successful result, in values and in keys', async () => {
    const gw = gatewayFor({
      [`${BASE}/5.0/projects/${PROJECT}`]: {
        body: { data: { projectId: PROJECT, projectName: `Echo ${KEY}`, [`field ${KEY}`]: 'x' } },
      },
    });

    const result = await gw.callTool('get_project', { projectId: PROJECT });

    expect(result.isError).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(JSON.stringify(result.structuredContent)).toContain('Echo [REDACTED]');
    expect(JSON.stringify(result.structuredContent)).toContain('field [REDACTED]');
  });

  it('redacts strings however deep they are nested', async () => {
    let deep: unknown = `deep ${KEY}`;
    for (let i = 0; i < 80; i += 1) deep = { level: deep };
    const gw = gatewayFor({ [`${BASE}/5.0/projects/${PROJECT}`]: { body: { data: { projectId: PROJECT, deep } } } });

    const result = await gw.callTool('get_project', { projectId: PROJECT });

    expect(JSON.stringify(result)).not.toContain(KEY);
  });
});
