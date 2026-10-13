import { describe, expect, it, vi } from 'vitest';
import { DaluxClient } from '../src/dalux/client.js';
import { getTask } from '../src/dalux/tasks.js';
import { listFiles } from '../src/dalux/box.js';

function client(calls: string[]): DaluxClient {
  const fetchImpl = vi.fn(async (input: string | URL | Request) => {
    calls.push(String(input));
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return new DaluxClient({ apiKey: 'k', fetchImpl });
}

describe('dalux id guard', () => {
  it.each(['..', '.', 'a/b', '%2e%2e'])('rejects %j as an id before calling the API', async id => {
    const calls: string[] = [];
    await expect(getTask(client(calls), { projectId: '1', taskId: id })).rejects.toThrow(/Invalid taskId/);
    await expect(listFiles(client(calls), { projectId: id, fileAreaId: '2' })).rejects.toThrow(/Invalid projectId/);
    expect(calls).toEqual([]);
  });
});
