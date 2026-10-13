import { describe, expect, it, vi } from 'vitest';
import { DaluxClient } from '../src/dalux/client.js';
import { fetchPages } from '../src/dalux/pagination.js';

const BASE = 'https://field.dalux.com/service/api';

function clientFor(pages: Record<string, unknown>): DaluxClient {
  const fetchImpl = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    const payload = pages[url];
    if (!payload) {
      return new Response('not found', { status: 404 });
    }
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  return new DaluxClient({ apiKey: 'k', fetchImpl });
}

describe('fetchPages', () => {
  it('follows links[] with rel, as the API answers live', async () => {
    const client = clientFor({
      [`${BASE}/5.1/projects`]: {
        items: [{ data: { projectId: '1', projectName: 'A' } }],
        links: [
          { rel: 'self', href: `${BASE}/5.1/projects`, method: 'GET' },
          { rel: 'nextPage', href: `${BASE}/5.1/projects?bookmark=2`, method: 'GET' },
        ],
        metadata: { totalItems: 2, totalRemainingItems: 2 },
      },
      [`${BASE}/5.1/projects?bookmark=2`]: {
        items: [{ data: { projectId: '2', projectName: 'B' } }],
        links: [{ rel: 'self', href: `${BASE}/5.1/projects?bookmark=2`, method: 'GET' }],
        metadata: { totalItems: 2, totalRemainingItems: 1 },
      },
    });

    const result = await fetchPages(client, '/5.1/projects');
    expect(result.items).toEqual([{ data: { projectId: '1', projectName: 'A' } }, { data: { projectId: '2', projectName: 'B' } }]);
    expect(result.pagesFetched).toBe(2);
    expect(result.nextPage).toBeUndefined();
  });

  it('ends an incremental links[] stream at nextPage == self', async () => {
    const self = `${BASE}/2.3/projects/1/tasks/changes`;
    const client = clientFor({
      [self]: { items: [{ data: { taskId: 'a' } }], links: [{ rel: 'self', href: self }, { rel: 'nextPage', href: self }] },
    });
    const result = await fetchPages(client, '/2.3/projects/1/tasks/changes');
    expect(result.endOfIncrementalStream).toBe(true);
    expect(result.nextPage).toBe(self);
  });

  it('follows opaque nextPage links and concatenates items', async () => {
    const client = clientFor({
      [`${BASE}/5.1/projects`]: {
        link: { self: { href: `${BASE}/5.1/projects` }, nextPage: { href: `${BASE}/5.1/projects?bookmark=2` } },
        items: [{ projectId: '1' }],
      },
      [`${BASE}/5.1/projects?bookmark=2`]: {
        link: { self: { href: `${BASE}/5.1/projects?bookmark=2` } },
        items: [{ projectId: '2' }],
      },
    });

    const result = await fetchPages(client, '/5.1/projects');
    expect(result.items).toEqual([{ projectId: '1' }, { projectId: '2' }]);
    expect(result.pagesFetched).toBe(2);
    expect(result.nextPage).toBeUndefined();
    expect(result.endOfIncrementalStream).toBe(false);
  });

  it('stops at maxPages and returns the continuation link', async () => {
    const client = clientFor({
      [`${BASE}/5.1/projects`]: {
        link: { self: { href: `${BASE}/5.1/projects` }, nextPage: { href: `${BASE}/5.1/projects?bookmark=2` } },
        items: [{ projectId: '1' }],
      },
      [`${BASE}/5.1/projects?bookmark=2`]: {
        link: { self: { href: `${BASE}/5.1/projects?bookmark=2` }, nextPage: { href: `${BASE}/5.1/projects?bookmark=3` } },
        items: [{ projectId: '2' }],
      },
    });

    const result = await fetchPages(client, '/5.1/projects', { maxPages: 2 });
    expect(result.items).toHaveLength(2);
    expect(result.nextPage).toBe(`${BASE}/5.1/projects?bookmark=3`);
  });

  it('detects the end of an incremental stream (nextPage == self) and keeps the resume link', async () => {
    const client = clientFor({
      [`${BASE}/2.3/projects/1/tasks/changes`]: {
        link: {
          self: { href: `${BASE}/2.3/projects/1/tasks/changes` },
          nextPage: { href: `${BASE}/2.3/projects/1/tasks/changes` },
        },
        items: [{ taskId: 'a', deleted: true }],
      },
    });

    const result = await fetchPages(client, '/2.3/projects/1/tasks/changes');
    expect(result.endOfIncrementalStream).toBe(true);
    expect(result.nextPage).toBe(`${BASE}/2.3/projects/1/tasks/changes`);
    expect(result.pagesFetched).toBe(1);
  });

  it('resumes from a pageLink instead of the path', async () => {
    const client = clientFor({
      [`${BASE}/5.1/projects?bookmark=9`]: {
        link: { self: { href: `${BASE}/5.1/projects?bookmark=9` } },
        items: [{ projectId: '9' }],
      },
    });

    const result = await fetchPages(client, '/5.1/projects', { pageLink: `${BASE}/5.1/projects?bookmark=9` });
    expect(result.items).toEqual([{ projectId: '9' }]);
  });

  it.each([
    ['another resource on the API', `${BASE}/1.0/projects/1/users`],
    ['a path outside the API base', 'https://field.dalux.com/other/5.1/projects'],
    ['dot segments', `${BASE}/5.1/projects/../../1.2/companyCatalog`],
    ['encoded dot segments', `${BASE}/5.1/projects/%2e%2e/x`],
  ])('refuses pageLinks pointing at %s', async (_label, pageLink) => {
    const client = clientFor({});
    await expect(fetchPages(client, '/5.1/projects', { pageLink })).rejects.toThrow(/Refusing to follow/);
  });

  it('refuses nextPage links that leave the requested resource', async () => {
    const client = clientFor({
      [`${BASE}/5.1/projects`]: {
        links: [{ rel: 'nextPage', href: `${BASE}/5.0/projects/1` }],
        items: [{ projectId: '1' }],
      },
    });
    await expect(fetchPages(client, '/5.1/projects')).rejects.toThrow(/different resource/);
  });

  it('accepts a continuation link on a different API version of the same resource', async () => {
    const client = clientFor({
      [`${BASE}/5.2/projects/1/tasks?bookmark=a`]: { items: [{ taskId: 'x' }] },
    });
    const result = await fetchPages(client, '/5.2/projects/1/tasks', { pageLink: `${BASE}/5.2/projects/1/tasks?bookmark=a` });
    expect(result.items).toEqual([{ taskId: 'x' }]);
  });

  it('refuses pageLinks pointing outside the API origin', async () => {
    const client = clientFor({});
    await expect(
      fetchPages(client, '/5.1/projects', { pageLink: 'https://attacker.example.com/page' }),
    ).rejects.toThrow('outside');
  });
});
