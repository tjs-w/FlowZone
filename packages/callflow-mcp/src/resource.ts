import { RESOURCE_MIME_TYPE, registerAppResource } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { configureCallFlowHtml, type CallFlowUiAssetLoader } from "./assets.js";

export const CALLFLOW_TEMPLATE_URI = "ui://callflow/workflow/v1.html";

const UI_METADATA = {
  prefersBorder: true,
  csp: {
    connectDomains: [] as string[],
    resourceDomains: [] as string[],
    frameDomains: [] as string[],
  },
  permissions: { clipboardWrite: {} },
};

export function registerCallFlowResource(
  server: McpServer,
  assetLoader: CallFlowUiAssetLoader,
): void {
  registerAppResource(
    server,
    "CallFlow workflow",
    CALLFLOW_TEMPLATE_URI,
    {
      description:
        "An accessible outline, workflow canvas, and evidence inspector for a bounded CallFlow graph.",
      _meta: { ui: UI_METADATA },
    },
    async () => {
      const html = configureCallFlowHtml(await assetLoader.load());
      return {
        contents: [
          {
            uri: CALLFLOW_TEMPLATE_URI,
            mimeType: RESOURCE_MIME_TYPE,
            text: html,
            _meta: {
              ui: UI_METADATA,
              "openai/widgetDescription":
                "CallFlow explores one bounded, evidence-backed local code workflow.",
              "openai/widgetPrefersBorder": true,
            },
          },
        ],
      };
    },
  );
}
