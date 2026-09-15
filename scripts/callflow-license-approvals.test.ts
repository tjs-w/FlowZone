import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { Metafile } from "esbuild";

import {
  CALLFLOW_LICENSE_APPROVALS,
  createCallFlowLicenseArtifacts,
} from "./callflow-license-approvals.js";

function licenseFilename(name: string, version: string): string {
  return `${name.replace(/^@/, "").replaceAll("/", "--")}-${version}-LICENSE.txt`;
}

async function rejectionMessage(operation: () => Promise<unknown>): Promise<string> {
  let rejection: unknown;
  try {
    await operation();
  } catch (error) {
    rejection = error;
  }
  if (rejection === undefined) throw new Error("Expected operation to reject.");
  if (!(rejection instanceof Error)) throw new Error("Expected operation to reject with Error.");
  return rejection.message;
}

async function packageMetafile(root: string): Promise<Metafile> {
  const inputs: Metafile["inputs"] = {};
  const outputInputs: Metafile["outputs"][string]["inputs"] = {};
  for (const approval of CALLFLOW_LICENSE_APPROVALS) {
    const relativeSource = join("node_modules", approval.name, "index.js");
    const absoluteSource = resolve(root, relativeSource);
    await mkdir(dirname(absoluteSource), { recursive: true });
    await Promise.all([
      writeFile(
        resolve(dirname(absoluteSource), "package.json"),
        `${JSON.stringify({
          name: approval.name,
          version: approval.version,
          license: approval.declaredLicense,
        })}\n`,
      ),
      writeFile(
        resolve(dirname(absoluteSource), "LICENSE"),
        await readFile(
          resolve(
            import.meta.dir,
            "../licenses/callflow",
            licenseFilename(approval.name, approval.version),
          ),
        ),
      ),
      writeFile(absoluteSource, "export {};\n"),
    ]);
    inputs[relativeSource] = { bytes: 11, imports: [], format: "esm" };
    outputInputs[relativeSource] = { bytesInOutput: 1 };
  }
  return {
    inputs,
    outputs: {
      "callflow.cjs": {
        bytes: CALLFLOW_LICENSE_APPROVALS.length,
        entryPoint: "index.js",
        exports: [],
        imports: [],
        inputs: outputInputs,
      },
    },
  };
}

describe("CallFlow bundled-license inventory", () => {
  test("emits an exact SBOM and rejects only byte-contributing unknown packages", async () => {
    const root = await mkdtemp(join(tmpdir(), "callflow-license-test-"));
    try {
      const metafile = await packageMetafile(root);
      const artifacts = await createCallFlowLicenseArtifacts(root, [
        { bundle: "callflow.cjs", metafile },
      ]);
      const sbom = artifacts.find((artifact) => artifact.path === "sbom.json");
      expect(sbom).toBeDefined();
      const parsed = JSON.parse(new TextDecoder().decode(sbom?.content)) as {
        schema: string;
        packages: unknown[];
      };
      expect(parsed.schema).toBe("callflow/dependency-sbom-v1");
      expect(parsed.packages).toHaveLength(CALLFLOW_LICENSE_APPROVALS.length);

      const unknownSource = resolve(root, "node_modules/unknown-package/index.js");
      await mkdir(dirname(unknownSource), { recursive: true });
      await Promise.all([
        writeFile(
          resolve(dirname(unknownSource), "package.json"),
          `${JSON.stringify({ name: "unknown-package", version: "1.0.0", license: "MIT" })}\n`,
        ),
        writeFile(resolve(dirname(unknownSource), "LICENSE"), "MIT\n"),
        writeFile(unknownSource, "export {};\n"),
      ]);
      const baseOutput = metafile.outputs["callflow.cjs"];
      if (!baseOutput) throw new Error("Synthetic CallFlow bundle output is missing.");
      const poisoned: Metafile = {
        inputs: {
          ...metafile.inputs,
          "node_modules/unknown-package/index.js": { bytes: 11, imports: [], format: "esm" },
        },
        outputs: {
          "callflow.cjs": {
            ...baseOutput,
            inputs: { ...baseOutput.inputs },
          },
        },
      };
      const zeroByteArtifacts = await createCallFlowLicenseArtifacts(root, [
        { bundle: "callflow.cjs", metafile: poisoned },
      ]);
      expect(zeroByteArtifacts).toBeDefined();

      const poisonedOutput = poisoned.outputs["callflow.cjs"];
      if (!poisonedOutput) throw new Error("Synthetic poisoned bundle output is missing.");
      poisonedOutput.inputs["node_modules/unknown-package/index.js"] = {
        bytesInOutput: 1,
      };
      expect(
        await rejectionMessage(() =>
          createCallFlowLicenseArtifacts(root, [{ bundle: "callflow.cjs", metafile: poisoned }]),
        ),
      ).toContain("unapproved dependency unknown-package@1.0.0");
      const filteredArtifacts = await createCallFlowLicenseArtifacts(root, [
        {
          bundle: "server/dist/server.cjs",
          metafile: poisoned,
          includePackageIds: CALLFLOW_LICENSE_APPROVALS.map(
            (approval) => `${approval.name}@${approval.version}`,
          ),
        },
      ]);
      expect(filteredArtifacts.find((artifact) => artifact.path === "sbom.json")).toBeDefined();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("rejects changed approved license text", async () => {
    const root = await mkdtemp(join(tmpdir(), "callflow-license-digest-test-"));
    try {
      const metafile = await packageMetafile(root);
      const approval = CALLFLOW_LICENSE_APPROVALS[0];
      if (!approval) throw new Error("CallFlow license allowlist is unexpectedly empty.");
      await writeFile(resolve(root, "node_modules", approval.name, "LICENSE"), "changed\n");
      expect(
        await rejectionMessage(() =>
          createCallFlowLicenseArtifacts(root, [{ bundle: "callflow.cjs", metafile }]),
        ),
      ).toContain("license text has digest");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
