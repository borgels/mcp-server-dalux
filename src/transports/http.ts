import { ConfigError } from '../config-env.js';
import { validatePolicyConfig } from '../dalux/policy.js';
import { getDefaultClient } from '../server.js';
import { configWarnings, getHttpConfig, type HttpConfig } from './http-helpers.js';
import { startHttpServer } from './http-server.js';
import { getExportConfig, type ExportConfig } from '../export/config.js';
import { DownloadStore, fileTarget, type ExportTarget } from '../export/delivery.js';
import { exportWorkspace } from '../export/workspace.js';

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
  let exportTarget: ExportTarget | undefined;
  if (exportConfig.publicBaseUrl || exportConfig.delivery === 'file') {
    let workspace;
    try {
      // Checks the export directory and removes stale archives of earlier processes.
      workspace = await exportWorkspace(exportConfig.dir);
    } catch (error) {
      console.error(`Dalux MCP HTTP server not started: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
    if (exportConfig.publicBaseUrl) {
      downloads = new DownloadStore({ config: exportConfig, workspace });
      console.error(
        `Export downloads enabled at ${exportConfig.publicBaseUrl}/downloads/ (links expire after ${exportConfig.ttlMs / 60_000} min)`,
      );
    } else {
      exportTarget = fileTarget();
      console.error('Exports are kept in DALUX_EXPORT_DIR (DALUX_EXPORT_DELIVERY=file).');
    }
  } else {
    console.error('dalux_export_quality_plans is unavailable: set DALUX_PUBLIC_BASE_URL for download links.');
  }

  const running = await startHttpServer(config, { downloads, exportTarget });
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
