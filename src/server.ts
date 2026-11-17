import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DaluxClient, type DaluxClientOptions } from './dalux/client.js';
import type { ExportDelivery } from './export/delivery.js';
import { defaultToolRuntime, registerDaluxTools, type DaluxCallContext } from './tools/dalux.js';
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
  /**
   * How finished exports reach the caller. Defaults to a local file in
   * DALUX_EXPORT_DIR; the HTTP transport passes download links when
   * DALUX_PUBLIC_BASE_URL is set.
   */
  exportDelivery?: ExportDelivery;
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
  const runtime = defaultToolRuntime();
  if (options.exportDelivery) {
    runtime.exportDelivery = options.exportDelivery;
  }
  registerDaluxTools(server, client, options.callContext, runtime);

  return server;
}
