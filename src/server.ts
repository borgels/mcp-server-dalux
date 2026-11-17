import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DaluxClient, type DaluxClientOptions } from './dalux/client.js';
import { registerDaluxTools, type DaluxCallContext } from './tools/dalux.js';
import { PACKAGE_VERSION } from './version.js';

export interface CreateServerOptions {
  client?: DaluxClient;
  clientOptions?: DaluxClientOptions;
  /**
   * Context applied to every tool call of this server instance, e.g. the
   * caller forwarded by a trusted gateway (recorded in the audit log). Each
   * call still gets its own request id unless one is set here.
   */
  callContext?: Pick<DaluxCallContext, 'caller'>;
}

let defaultClient: DaluxClient | undefined;

/**
 * Process-wide client built from the environment. Sharing it means the
 * outbound concurrency limit applies across all sessions, also when a server
 * instance is created per HTTP request.
 */
export function getDefaultClient(): DaluxClient {
  defaultClient ??= new DaluxClient();
  return defaultClient;
}

export function createServer(options: CreateServerOptions = {}): McpServer {
  const server = new McpServer({
    name: 'dalux',
    version: PACKAGE_VERSION,
  });

  const client =
    options.client ?? (options.clientOptions ? new DaluxClient(options.clientOptions) : getDefaultClient());
  registerDaluxTools(server, client, options.callContext);

  return server;
}
