import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DaluxClient, type DaluxClientOptions } from './dalux/client.js';
import { registerDaluxTools } from './tools/dalux.js';

export interface CreateServerOptions {
  client?: DaluxClient;
  clientOptions?: DaluxClientOptions;
}

export function createServer(options: CreateServerOptions = {}): McpServer {
  const server = new McpServer({
    name: 'dalux',
    version: '0.1.0',
  });

  const client = options.client ?? new DaluxClient(options.clientOptions);
  registerDaluxTools(server, client);

  return server;
}
