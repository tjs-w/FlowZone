import { readFile } from "node:fs/promises";

import { CallFlowError } from "@callflow/node";

export interface CallFlowUiAssets {
  readonly template: string;
  readonly bundle: string;
  readonly stylesheet: string;
}

export interface CallFlowUiAssetLoader {
  load(): Promise<CallFlowUiAssets>;
}

export interface FileCallFlowUiAssetLoaderOptions {
  readonly templatePath: string;
  readonly bundlePath: string;
  readonly stylesheetPath: string;
}

export function createFileCallFlowUiAssetLoader(
  options: FileCallFlowUiAssetLoaderOptions,
): CallFlowUiAssetLoader {
  return {
    async load(): Promise<CallFlowUiAssets> {
      const [template, bundle, stylesheet] = await Promise.all([
        readFile(options.templatePath, "utf8"),
        readFile(options.bundlePath, "utf8"),
        readFile(options.stylesheetPath, "utf8"),
      ]).catch(() => {
        throw new CallFlowError("unavailable", "The CallFlow UI assets are unavailable.");
      });
      return { template, bundle, stylesheet };
    },
  };
}

export function configureCallFlowHtml(assets: CallFlowUiAssets): string {
  const marker = "<!-- CALLFLOW_APP -->";
  if (!assets.template.includes(marker)) {
    throw new CallFlowError("invalid_output", "The CallFlow UI template is invalid.");
  }
  const template = assets.template.replace(
    "</head>",
    `<style>${assets.stylesheet.replaceAll("</style", "<\\/style")}</style></head>`,
  );
  return template.replace(
    marker,
    () => `<script>${assets.bundle.replaceAll("</script", "<\\/script")}</script>`,
  );
}
