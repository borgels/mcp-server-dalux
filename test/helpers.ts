import { readFileSync } from 'node:fs';
import { vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { DaluxClient } from '../src/dalux/client.js';
import { createServer } from '../src/server.js';
import { createDaluxGateway } from '../src/gateway.js';

export const BASE = 'https://field.dalux.com/service/api';

export type Stub = { status?: number; body?: unknown; raw?: string };

/** A fetch stub keyed by URL without query string. Unknown URLs answer 404. */
export function stubFetch(routes: Record<string, Stub>) {
  return vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const url = String(input).split('?')[0] ?? '';
    const stub = routes[url];
    if (!stub) {
      return new Response(JSON.stringify({ message: `no stub for ${url}` }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (stub.raw !== undefined) {
      return new Response(stub.raw, { status: stub.status ?? 200, headers: { 'content-type': 'text/plain' } });
    }
    return new Response(JSON.stringify(stub.body), {
      status: stub.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}

export async function connect(routes: Record<string, Stub> = {}) {
  const fetchImpl = stubFetch(routes);
  const daluxClient = new DaluxClient({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch });
  const server = createServer({ client: daluxClient });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcpClient = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);
  return { mcpClient, fetchImpl };
}

export function gateway(routes: Record<string, Stub> = {}) {
  const fetchImpl = stubFetch(routes);
  // At least 8 characters: the gateway refuses a key its redactor cannot protect.
  return { gw: createDaluxGateway({ apiKey: 'tttt-gggg-wwww-vvvv-1', baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch }), fetchImpl };
}

export function texts(result: unknown): string[] {
  return (((result as { content?: unknown }).content ?? []) as Array<{ text: string }>).map(c => c.text);
}

export function auditLines(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as Record<string, unknown>);
}
