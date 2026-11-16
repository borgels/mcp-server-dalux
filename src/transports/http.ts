import { realpathSync } from 'node:fs';
import {
  createServer as createNodeServer,
  type IncomingMessage,
  type RequestListener,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ConfigError } from '../config-env.js';
import { createServer as createDaluxMcpServer } from '../server.js';
import {
  assertAllowedHost,
  assertAllowedOrigin,
  assertAuthorized,
  AuthFailureLimiter,
  configWarnings,
  corsHeaders,
  getHttpConfig,
  type HttpConfig,
  HttpRequestError,
  readJsonBody,
  sendJson,
} from './http-helpers.js';

export interface HttpServerOptions {
  /** Factory for the per-request MCP server (tests inject a fake Dalux client). */
  createMcpServer?: () => McpServer;
  /** Defaults to console.error. */
  log?: (line: string) => void;
}

export interface RunningHttpServer {
  server: Server;
  port: number;
  close(): Promise<void>;
}

const SHUTDOWN_GRACE_MS = 10_000;

export function createHttpRequestHandler(config: HttpConfig, options: HttpServerOptions = {}): RequestListener {
  const createMcpServer = options.createMcpServer ?? (() => createDaluxMcpServer());
  const log = options.log ?? ((line: string) => console.error(line));
  const limiter = new AuthFailureLimiter(config.authFailureLimit ?? 20, config.authFailureWindowMs ?? 60_000);

  return async (req: IncomingMessage, res: ServerResponse) => {
    const remote = req.socket.remoteAddress ?? 'unknown';
    try {
      const path = (req.url ?? '/').split('?')[0];

      if (path === '/healthz' && (req.method === 'GET' || req.method === 'HEAD')) {
        sendJson(res, 200, { status: 'ok' });
        return;
      }

      if (path !== '/mcp') {
        throw new HttpRequestError(404, 'Not found');
      }

      assertAllowedHost(req, config);
      assertAllowedOrigin(req, config);

      if (req.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders(req, config));
        res.end();
        return;
      }

      if (req.method !== 'POST') {
        throw new HttpRequestError(405, 'Method not allowed', { headers: { Allow: 'POST, OPTIONS' } });
      }

      const retryAfter = limiter.retryAfterSeconds(remote);
      if (retryAfter > 0) {
        throw new HttpRequestError(429, 'Too many failed authentication attempts', {
          headers: { 'Retry-After': String(retryAfter) },
        });
      }

      try {
        assertAuthorized(req, config);
      } catch (error) {
        limiter.recordFailure(remote);
        throw error;
      }

      const body = await readJsonBody(req, config.maxBodyBytes);
      const mcpServer = createMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });

      res.on('close', () => {
        void transport.close();
        void mcpServer.close();
      });

      for (const [name, value] of Object.entries(corsHeaders(req, config))) {
        res.setHeader(name, value);
      }

      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      if (error instanceof HttpRequestError) {
        log(`[http] ${error.status} ${req.method ?? '-'} ${(req.url ?? '').slice(0, 200)} from ${remote}: ${error.message}`);
        if (!res.headersSent) {
          const payload = error.jsonRpcCode === undefined
            ? { error: error.message }
            : { jsonrpc: '2.0', error: { code: error.jsonRpcCode, message: error.message }, id: null };
          sendJson(res, error.status, payload, req, error.headers, config);
        }
        return;
      }

      log(`[http] 500 ${req.method ?? '-'} ${(req.url ?? '').slice(0, 200)} from ${remote}`);
      console.error(error);
      if (!res.headersSent) {
        sendJson(res, 500, {
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Internal server error',
          },
          id: null,
        }, req, {}, config);
      }
    }
  };
}

/** Starts the HTTP transport. `config.port` 0 picks an ephemeral port. */
export async function startHttpServer(
  config: HttpConfig,
  options: HttpServerOptions = {},
): Promise<RunningHttpServer> {
  const server = createNodeServer(createHttpRequestHandler(config, options));

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const port = (server.address() as AddressInfo).port;
  let closing: Promise<void> | undefined;

  return {
    server,
    port,
    close() {
      closing ??= new Promise<void>(resolve => {
        const force = setTimeout(() => server.closeAllConnections(), SHUTDOWN_GRACE_MS);
        force.unref();
        server.close(() => {
          clearTimeout(force);
          resolve();
        });
        server.closeIdleConnections();
      });
      return closing;
    },
  };
}

async function main(): Promise<void> {
  let config: HttpConfig;
  try {
    config = getHttpConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`Dalux MCP HTTP server not started: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }

  for (const warning of configWarnings(config)) {
    console.error(warning);
  }

  const running = await startHttpServer(config);
  console.error(`Dalux MCP HTTP server listening on http://${config.host}:${running.port}/mcp`);

  const shutdown = (signal: string) => {
    console.error(`Received ${signal}, shutting down`);
    void running.close().then(() => process.exit(0));
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}
