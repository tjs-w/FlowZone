import { resolve } from "node:path";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createFileCallFlowUiAssetLoader } from "./assets.js";
import { createCallFlowServer } from "./server.js";

const pluginRoot = resolve(__dirname, "../..");
const server = createCallFlowServer({
  assetLoader: createFileCallFlowUiAssetLoader({
    templatePath: resolve(pluginRoot, "web/callflow.html"),
    bundlePath: resolve(pluginRoot, "web/dist/callflow.js"),
    stylesheetPath: resolve(pluginRoot, "web/dist/callflow.css"),
  }),
});

const transport = new StdioServerTransport();
server.connect(transport).catch(() => {
  process.stderr.write("CallFlow MCP failed to start.\n");
  process.exitCode = 1;
});
