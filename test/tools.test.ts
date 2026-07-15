import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { DaluxClient } from '../src/dalux/client.js';
import { createServer } from '../src/server.js';
import { DALUX_CAPABILITIES, searchCapabilities } from '../src/dalux/capabilities.js';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

const BASE = 'https://field.dalux.com/service/api';

function makeClient(pages: Record<string, unknown>): DaluxClient {
  const fetchImpl = vi.fn(async (input: string | URL | Request) => {
    const url = String(input).split('?')[0] ?? '';
    const payload = pages[url];
    if (!payload) {
      return new Response(JSON.stringify({ code: 'E40401', message: `no stub for ${url}` }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  return new DaluxClient({ apiKey: 'k', fetchImpl });
}

async function connect(daluxClient: DaluxClient) {
  const server = createServer({ client: daluxClient });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcpClient = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);
  return mcpClient;
}

describe('MCP tool surface', () => {
  it('registers every capability as a tool with matching annotations', async () => {
    const mcpClient = await connect(makeClient({}));
    const { tools } = await mcpClient.listTools();
    const names = tools.map(t => t.name).sort();

    expect(names).toEqual(DALUX_CAPABILITIES.map(c => c.id).sort());

    for (const tool of tools) {
      const capability = DALUX_CAPABILITIES.find(c => c.id === tool.name);
      expect(tool.annotations?.readOnlyHint).toBe(capability?.risk === 'read');
    }
  });

  it('lists tasks through the MCP layer', async () => {
    const mcpClient = await connect(
      makeClient({
        [`${BASE}/5.2/projects/77/tasks`]: {
          link: { self: { href: `${BASE}/5.2/projects/77/tasks` } },
          items: [{ taskId: 't1', subject: 'Fjern asbest', usage: 'Task' }],
        },
      }),
    );

    const result = await mcpClient.callTool({
      name: 'dalux_list_tasks',
      arguments: { projectId: '77' },
    });

    const text = (result.content as Array<{ text: string }>)[0]?.text ?? '';
    expect(text).toContain('Fjern asbest');
    expect(JSON.parse(text).items).toHaveLength(1);
  });

  it('rejects write tools when writes are disabled, without calling Dalux', async () => {
    delete process.env.DALUX_ENABLE_WRITES;
    const dalux = makeClient({});
    const mcpClient = await connect(dalux);

    const result = await mcpClient.callTool({
      name: 'dalux_upload_file',
      arguments: {
        projectId: '1',
        fileAreaId: '2',
        fileName: 'x.pdf',
        contentBase64: Buffer.from('x').toString('base64'),
        folderId: '3',
      },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? '';
    expect(text).toContain('disabled');
  });
});

describe('capability search', () => {
  it('finds tools by Danish and English keywords', () => {
    expect(searchCapabilities('sikkerhed').map(c => c.id)).toContain('dalux_list_tasks');
    expect(searchCapabilities('drawings download').map(c => c.id)).toContain('dalux_download_file');
    expect(searchCapabilities('apv').map(c => c.id)).toContain('dalux_list_forms');
  });
});
