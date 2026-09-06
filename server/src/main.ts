import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createBundledFlowZoneServer } from "./runtime.js";

const server = createBundledFlowZoneServer();
const transport = new StdioServerTransport();

server.connect(transport).catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`FlowZone MCP failed: ${message}\n`);
  process.exitCode = 1;
});
