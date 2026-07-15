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
  it('follows opaque nextPage links and concatenates items', async () => {
    const client = clientFor({
      [`${BASE}/5.1/projects`]: {
        link: { self: { href: `${BASE}/5.1/projects` }, nextPage: { href: `${BASE}/page2` } },
        items: [{ projectId: '1' }],
      },
      [`${BASE}/page2`]: {
        link: { self: { href: `${BASE}/page2` } },
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
        link: { self: { href: `${BASE}/5.1/projects` }, nextPage: { href: `${BASE}/page2` } },
        items: [{ projectId: '1' }],
      },
      [`${BASE}/page2`]: {
        link: { self: { href: `${BASE}/page2` }, nextPage: { href: `${BASE}/page3` } },
        items: [{ projectId: '2' }],
      },
    });

    const result = await fetchPages(client, '/5.1/projects', { maxPages: 2 });
    expect(result.items).toHaveLength(2);
    expect(result.nextPage).toBe(`${BASE}/page3`);
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
      [`${BASE}/resume-here`]: {
        link: { self: { href: `${BASE}/resume-here` } },
        items: [{ projectId: '9' }],
      },
    });

    const result = await fetchPages(client, '/never-called', { pageLink: `${BASE}/resume-here` });
    expect(result.items).toEqual([{ projectId: '9' }]);
  });

  it('refuses pageLinks pointing outside the API origin', async () => {
    const client = clientFor({});
    await expect(
      fetchPages(client, '/5.1/projects', { pageLink: 'https://attacker.example.com/page' }),
    ).rejects.toThrow('outside');
  });
});
