import { resolve } from "node:path";

import {
  createFileFlowZoneUiAssetLoader,
  createFlowZoneServer,
  createMarkdownReviewPlugin,
  developerModeEnabled,
} from "@flowzone/mcp-server";
import { createDynaPlugin } from "@flowzone/mcp-server/dyna";

const pluginRoot = resolve(__dirname, "../..");

export function createBundledFlowZoneServer() {
  const assetLoader = createFileFlowZoneUiAssetLoader({
    templatePath: resolve(pluginRoot, "web/flowzone.html"),
    bundlePath: resolve(pluginRoot, "web/dist/flowzone.js"),
  });
  const dynaAssetLoader = createFileFlowZoneUiAssetLoader({
    templatePath: resolve(pluginRoot, "web/dyna.html"),
    bundlePath: resolve(pluginRoot, "web/dist/dyna.js"),
    stylesheetPath: resolve(pluginRoot, "web/dist/dyna.css"),
  });
  return createFlowZoneServer({
    assetLoader,
    allowNativeDevTools: developerModeEnabled(process.env["FLOWZONE_DEVTOOLS"]),
    uiResources: [
      {
        name: "FlowZone Dyna UI",
        resourceUri: "ui://flowzone/dyna/v6.html",
        assetLoader: dynaAssetLoader,
        description:
          "Dyna is a responsive executive dashboard for prioritized scheduled signals and Codex actions.",
      },
    ],
    plugins: [createMarkdownReviewPlugin(), createDynaPlugin()],
  });
}
