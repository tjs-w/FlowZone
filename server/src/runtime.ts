import { resolve } from "node:path";

import {
  createFileFlowZoneUiAssetLoader,
  createFlowZoneServer,
  createMarkdownReviewPlugin,
  developerModeEnabled,
} from "@flowzone/mcp-server";
import {
  createDynaPlugin,
  DYNA_TEMPLATE_URI,
  LEGACY_DYNA_TEMPLATE_URIS,
} from "@flowzone/mcp-server/dyna";

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
        resourceUri: DYNA_TEMPLATE_URI,
        assetLoader: dynaAssetLoader,
        description:
          "Dyna is a responsive executive dashboard for prioritized scheduled signals and Codex actions.",
        permissions: { clipboardWrite: {} },
      },
      ...LEGACY_DYNA_TEMPLATE_URIS.map((resourceUri) => ({
        name: `FlowZone Dyna UI (legacy ${resourceUri})`,
        resourceUri,
        assetLoader: dynaAssetLoader,
        description:
          "Dyna is a responsive executive dashboard for prioritized scheduled signals and Codex actions.",
        permissions: { clipboardWrite: {} },
      })),
    ],
    plugins: [createMarkdownReviewPlugin(), createDynaPlugin()],
  });
}
