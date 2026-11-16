import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { DaluxClient } from '../src/dalux/client.js';
import { createServer } from '../src/server.js';
import type { HttpConfig } from '../src/transports/http-helpers.js';
import { type RunningHttpServer, startHttpServer } from '../src/transports/http.js';

const TOKEN = 'test-token-0123456789abcdef0123456789';

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function send(
  port: number,
  options: { method?: string; path?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: options.method ?? 'POST',
        path: options.path ?? '/mcp',
        headers: options.headers,
      },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(chunk as Buffer));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('error', reject);
    req.end(options.body);
  });
}

const toolsList = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
const mcpHeaders = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
};

function fakeMcpServer() {
  const client = new DaluxClient({
    apiKey: 'test',
    fetchImpl: async () => {
      throw new Error('network access is not allowed in tests');
    },
  });
  return createServer({ client });
}

describe('HTTP transport (integration)', () => {
  let running: RunningHttpServer | undefined;
  const logs: string[] = [];

  async function start(overrides: Partial<HttpConfig> = {}): Promise<number> {
    const config: HttpConfig = {
      host: '127.0.0.1',
      port: 0,
      maxBodyBytes: 1024 * 1024,
      httpToken: TOKEN,
      authFailureLimit: 5,
      authFailureWindowMs: 60_000,
      ...overrides,
    };
    running = await startHttpServer(config, { createMcpServer: fakeMcpServer, log: line => logs.push(line) });
    return running.port;
  }

  afterEach(async () => {
    await running?.close();
    running = undefined;
    logs.length = 0;
  });

  it('serves /healthz without auth', async () => {
    const port = await start();
    const reply = await send(port, { method: 'GET', path: '/healthz' });
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body)).toEqual({ status: 'ok' });
  });

  it('returns 401 with WWW-Authenticate without or with a wrong token', async () => {
    const port = await start();
    const missing = await send(port, { headers: mcpHeaders, body: toolsList });
    expect(missing.status).toBe(401);
    expect(missing.headers['www-authenticate']).toBe('Bearer');

    const wrong = await send(port, {
      headers: { ...mcpHeaders, Authorization: 'Bearer wrong-token' },
      body: toolsList,
    });
    expect(wrong.status).toBe(401);
    expect(logs.some(line => line.includes('401') && line.includes('Unauthorized'))).toBe(true);
  });

  it('lists tools with a valid token and sets CORS headers for an allowed origin', async () => {
    const port = await start();
    const reply = await send(port, {
      headers: { ...mcpHeaders, Authorization: `Bearer ${TOKEN}`, Origin: 'http://localhost:5173' },
      body: toolsList,
    });
    expect(reply.status).toBe(200);
    expect(reply.body).toContain('"tools"');
    expect(reply.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });

  it('answers CORS preflight including mcp-protocol-version', async () => {
    const port = await start();
    const reply = await send(port, { method: 'OPTIONS', headers: { Origin: 'http://localhost:5173' } });
    expect(reply.status).toBe(204);
    expect(reply.headers['access-control-allow-headers']).toContain('mcp-protocol-version');
  });

  it('returns 403 for a disallowed origin or Host header', async () => {
    const port = await start();
    const badOrigin = await send(port, {
      headers: { ...mcpHeaders, Authorization: `Bearer ${TOKEN}`, Origin: 'https://evil.example' },
      body: toolsList,
    });
    expect(badOrigin.status).toBe(403);

    const badHost = await send(port, {
      headers: { ...mcpHeaders, Authorization: `Bearer ${TOKEN}`, Host: 'rebind.example' },
      body: toolsList,
    });
    expect(badHost.status).toBe(403);
  });

  it('returns 400 with a JSON-RPC parse error for invalid JSON', async () => {
    const port = await start();
    const reply = await send(port, {
      headers: { ...mcpHeaders, Authorization: `Bearer ${TOKEN}` },
      body: '{not json',
    });
    expect(reply.status).toBe(400);
    expect(JSON.parse(reply.body)).toMatchObject({ jsonrpc: '2.0', error: { code: -32700 }, id: null });
  });

  it('returns 413 for an oversized body', async () => {
    const port = await start({ maxBodyBytes: 16 });
    const reply = await send(port, {
      headers: { ...mcpHeaders, Authorization: `Bearer ${TOKEN}` },
      body: toolsList,
    });
    expect(reply.status).toBe(413);
  });

  it('returns 429 with Retry-After after repeated auth failures, even for the right token', async () => {
    const port = await start({ authFailureLimit: 3 });
    for (let i = 0; i < 3; i++) {
      const reply = await send(port, { headers: { ...mcpHeaders, Authorization: 'Bearer nope' }, body: toolsList });
      expect(reply.status).toBe(401);
    }
    const blocked = await send(port, {
      headers: { ...mcpHeaders, Authorization: `Bearer ${TOKEN}` },
      body: toolsList,
    });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('returns 404 for other paths and 405 for other methods', async () => {
    const port = await start();
    expect((await send(port, { method: 'GET', path: '/other' })).status).toBe(404);
    const get = await send(port, { method: 'GET', headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(get.status).toBe(405);
  });
});

describe('HTTP transport entry point', () => {
  const entry = fileURLToPath(new URL('../src/transports/http.ts', import.meta.url));

  function runEntry(env: Record<string, string>): Promise<{ code: number | null; stderr: string }> {
    return new Promise((resolve, reject) => {
      const childEnv: NodeJS.ProcessEnv = { ...process.env };
      for (const name of Object.keys(childEnv)) {
        if (name.startsWith('MCP_') || name === 'HOST' || name === 'PORT') {
          delete childEnv[name];
        }
      }
      const child = spawn(process.execPath, ['--import', 'tsx', entry], {
        env: { ...childEnv, ...env },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', chunk => {
        stderr += String(chunk);
      });
      const timer = setTimeout(() => child.kill(), 20_000);
      child.on('error', reject);
      child.on('exit', code => {
        clearTimeout(timer);
        resolve({ code, stderr });
      });
    });
  }

  it.each([
    [{ HOST: '0.0.0.0' }, /MCP_HTTP_TOKEN/],
    [{ MCP_ALLOW_ANY_ORIGIN: 'true' }, /MCP_ALLOW_ANY_ORIGIN/],
    [{ MCP_HTTP_TOKEN: 'too-short' }, /at least 32/],
    [{ PORT: 'abc' }, /PORT/],
  ])('refuses to start with %o', async (env, message) => {
    const result = await runEntry(env);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(message);
    expect(result.stderr).toContain('not started');
  }, 30_000);
});
