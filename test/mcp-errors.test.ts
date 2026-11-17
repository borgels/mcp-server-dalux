import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { DaluxClient } from '../src/dalux/client.js';
import { createServer } from '../src/server.js';
import { findDaluxTool } from '../src/tools/dalux.js';
import { BASE, stubFetch, texts } from './helpers.js';

// Built at runtime so no key-shaped literal sits in the source.
const API_KEY = ['handler', 'leak', 'x'.repeat(16)].join('-');

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MCP tool errors', () => {
  it('redacts the API key from an error a handler throws', async () => {
    const tool = findDaluxTool('dalux_list_tasks');
    expect(tool).toBeDefined();
    vi.spyOn(tool!, 'handler').mockRejectedValue(new Error(`unexpected failure with key ${API_KEY} in it`));

    const fetchImpl = stubFetch({});
    const daluxClient = new DaluxClient({ apiKey: API_KEY, baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch });
    const server = createServer({ client: daluxClient });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);

    const result = await mcpClient.callTool({
      name: 'dalux_list_tasks',
      arguments: { projectId: '900000000000000001' },
    });
    expect(result.isError).toBe(true);
    const text = texts(result).join(' ');
    expect(text).toContain('unexpected failure with key');
    expect(text).not.toContain(API_KEY);
  });
});
