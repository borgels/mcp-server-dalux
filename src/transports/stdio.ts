#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { fileTarget } from '../export/delivery.js';
import { createServer } from '../server.js';

async function main(): Promise<void> {
  // Exports stay on this machine; the tool returns the archive path.
  const server = createServer({ exportTarget: fileTarget() });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
