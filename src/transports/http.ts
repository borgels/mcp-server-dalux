import { ConfigError } from '../config-env.js';
import { validatePolicyConfig } from '../dalux/policy.js';
import { getDefaultClient } from '../server.js';
import { configWarnings, getHttpConfig, type HttpConfig } from './http-helpers.js';
import { startHttpServer } from './http-server.js';
import { getExportConfig, type ExportConfig } from '../export/config.js';
import { DownloadStore } from '../export/delivery.js';

async function main(): Promise<void> {
  let config: HttpConfig;
  let exportConfig: ExportConfig;
  try {
    config = getHttpConfig();
    exportConfig = getExportConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`Dalux MCP HTTP server not started: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }

  try {
    // Validate the Dalux client and policy configuration once at startup
    // instead of on every request.
    getDefaultClient();
    validatePolicyConfig();
  } catch (error) {
    console.error(`Dalux MCP HTTP server not started: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  for (const warning of configWarnings(config)) {
    console.error(warning);
  }

  let downloads: DownloadStore | undefined;
  if (exportConfig.publicBaseUrl) {
    downloads = new DownloadStore({ config: exportConfig });
    await downloads.removeLeftovers();
    console.error(
      `Export downloads enabled at ${exportConfig.publicBaseUrl}/downloads/ (links expire after ${exportConfig.ttlMs / 60_000} min)`,
    );
  }

  const running = await startHttpServer(config, { downloads });
  console.error(`Dalux MCP HTTP server listening on http://${config.host}:${running.port}/mcp`);

  const shutdown = (signal: string) => {
    console.error(`Received ${signal}, shutting down`);
    void running.close().then(() => process.exit(0));
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
