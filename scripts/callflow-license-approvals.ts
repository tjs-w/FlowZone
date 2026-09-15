import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import type { Metafile } from "esbuild";

export interface CallFlowBundleMetafile {
  readonly bundle: string;
  readonly includePackageIds?: readonly string[];
  readonly metafile: Metafile;
}

export interface LicenseApproval {
  readonly name: string;
  readonly version: string;
  readonly declaredLicense: string;
  readonly selectedLicense: string;
  readonly licenseDigest: string;
}

interface PackageMetadata {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly license?: unknown;
}

export interface CallFlowLicenseArtifact {
  readonly path: string;
  readonly content: Uint8Array;
}

const approvals = [
  ["@modelcontextprotocol/ext-apps", "1.7.5", "MIT", "Apache-2.0 AND MIT"],
  ["@modelcontextprotocol/sdk", "1.30.0", "MIT", "MIT"],
  ["@openai/apps-sdk-ui", "0.2.2", "MIT", "MIT"],
  ["@xyflow/react", "12.11.6", "MIT", "MIT"],
  ["@xyflow/system", "0.0.82", "MIT", "MIT"],
  ["ajv", "8.20.0", "MIT", "MIT"],
  ["ajv-formats", "3.0.1", "MIT", "MIT"],
  ["classcat", "5.0.5", "MIT", "MIT"],
  ["d3-color", "3.1.0", "ISC", "ISC"],
  ["d3-dispatch", "3.0.1", "ISC", "ISC"],
  ["d3-drag", "3.0.0", "ISC", "ISC"],
  ["d3-ease", "3.0.1", "BSD-3-Clause", "BSD-3-Clause"],
  ["d3-interpolate", "3.0.1", "ISC", "ISC"],
  ["d3-selection", "3.0.0", "ISC", "ISC"],
  ["d3-timer", "3.0.1", "ISC", "ISC"],
  ["d3-transition", "3.0.1", "ISC", "ISC"],
  ["d3-zoom", "3.0.0", "ISC", "ISC"],
  ["elkjs", "0.12.0", "EPL-2.0 OR GPL-3.0-or-later", "EPL-2.0"],
  ["fast-deep-equal", "3.1.3", "MIT", "MIT"],
  ["fast-uri", "3.1.6", "BSD-3-Clause", "BSD-3-Clause"],
  ["json-schema-traverse", "1.0.0", "MIT", "MIT"],
  ["react", "19.2.8", "MIT", "MIT"],
  ["react-dom", "19.2.8", "MIT", "MIT"],
  ["scheduler", "0.27.0", "MIT", "MIT"],
  ["use-sync-external-store", "1.7.0", "MIT", "MIT"],
  ["zod", "4.4.3", "MIT", "MIT"],
  ["zod-to-json-schema", "3.25.2", "ISC", "ISC"],
  ["zustand", "4.5.7", "MIT", "MIT"],
] as const;

const LICENSE_DIGESTS: Readonly<Record<string, string>> = {
  "@modelcontextprotocol/ext-apps@1.7.5":
    "0382b0057770ca05e9c350a50aa3b1c1fea84da0bc81d723bf00b9aa841be58a",
  "@modelcontextprotocol/sdk@1.30.0":
    "5e13dbbc1d120fc2a03cecde7c91424ae2d7de11b63d58ded2f4431e261ee50d",
  "@openai/apps-sdk-ui@0.2.2": "f26a46776c890b0d7b45d042cb8a78fdca9c4742a5c7fd97f0f53767411b1cc6",
  "@xyflow/react@12.11.6": "023119ac20fb1c8c9930abe0bcd196989a1960388529a96fc43cebf96f07c9ff",
  "@xyflow/system@0.0.82": "023119ac20fb1c8c9930abe0bcd196989a1960388529a96fc43cebf96f07c9ff",
  "ajv@8.20.0": "a05350a88e318e4f5f2c2a1ff1e2e88daa4dd38e6e78b71cccae422bdc762cc3",
  "ajv-formats@3.0.1": "9df3bb69929a3b650ed73b3bfa1756725aaff0ac296461605753547004eafeaf",
  "classcat@5.0.5": "f101c761d255d0dddc77dd8a9327733b03d381798ec54a1bb718367207b48a8e",
  "d3-color@3.1.0": "faa682e3e430941f958d26180458f5934a62f58dac4d70ccdd15608c15d0f884",
  "d3-dispatch@3.0.1": "e008c5e25a6be382593089c29bfabbc553c6378eee02895aec46ce396cc404ee",
  "d3-drag@3.0.0": "e008c5e25a6be382593089c29bfabbc553c6378eee02895aec46ce396cc404ee",
  "d3-ease@3.0.1": "b989d9085148d21ff64a75e14462aefa06b2589a55553b07b1460c70081c7d08",
  "d3-interpolate@3.0.1": "e008c5e25a6be382593089c29bfabbc553c6378eee02895aec46ce396cc404ee",
  "d3-selection@3.0.0": "e008c5e25a6be382593089c29bfabbc553c6378eee02895aec46ce396cc404ee",
  "d3-timer@3.0.1": "e008c5e25a6be382593089c29bfabbc553c6378eee02895aec46ce396cc404ee",
  "d3-transition@3.0.1": "e008c5e25a6be382593089c29bfabbc553c6378eee02895aec46ce396cc404ee",
  "d3-zoom@3.0.0": "e008c5e25a6be382593089c29bfabbc553c6378eee02895aec46ce396cc404ee",
  "elkjs@0.12.0": "637e81f4a1b6b4079535c499fca05e238cf7605c1ff5b76d60d7da7ce96700c9",
  "fast-deep-equal@3.1.3": "7bf9b2de73a6b356761c948d0e9eeb4be6c1270bd04c79cd489c1e400ffdfc1a",
  "fast-uri@3.1.6": "b010b0dfdfdb23d7396e03b82cd4621fc9bb8f95d6b0aea70b9c24e12074c786",
  "json-schema-traverse@1.0.0": "7bf9b2de73a6b356761c948d0e9eeb4be6c1270bd04c79cd489c1e400ffdfc1a",
  "react@19.2.8": "da6d3703ed11cbe42bd212c725957c98da23cbff1998c05fa4b3d976d1a58e93",
  "react-dom@19.2.8": "da6d3703ed11cbe42bd212c725957c98da23cbff1998c05fa4b3d976d1a58e93",
  "scheduler@0.27.0": "da6d3703ed11cbe42bd212c725957c98da23cbff1998c05fa4b3d976d1a58e93",
  "use-sync-external-store@1.7.0":
    "da6d3703ed11cbe42bd212c725957c98da23cbff1998c05fa4b3d976d1a58e93",
  "zod@4.4.3": "3f1189b28e3866e0d979968d466b78f813f76827cfdca1fbb124cc0a5c8841f8",
  "zod-to-json-schema@3.25.2": "80d3168ad2f70f6f5bb2ab22b23414707abf6f0a392034891481ae36a1a429d4",
  "zustand@4.5.7": "c1e6e266563517467b1bf874817d23e426f3149252bd7d42758cd697514b8417",
};

export const CALLFLOW_LICENSE_APPROVALS: readonly LicenseApproval[] = approvals.map(
  ([name, version, declaredLicense, selectedLicense]) => {
    const licenseDigest = LICENSE_DIGESTS[`${name}@${version}`];
    if (!licenseDigest) throw new Error(`Missing approved license digest for ${name}@${version}.`);
    return {
      name,
      version,
      declaredLicense,
      selectedLicense,
      licenseDigest,
    };
  },
);

// These packages are part of the pre-existing shared FlowZone MCP runtime used
// by CallFlow. Inventory them from the real shared server metafile without
// attributing unrelated Markdown Review or Dyna dependencies to CallFlow.
export const CALLFLOW_SHARED_FLOWZONE_LICENSE_IDS = [
  "ajv@8.20.0",
  "ajv-formats@3.0.1",
  "fast-deep-equal@3.1.3",
  "fast-uri@3.1.6",
  "json-schema-traverse@1.0.0",
] as const;

function packageId(name: string, version: string): string {
  return `${name}@${version}`;
}

function licenseFilename(name: string, version: string): string {
  const safeName = name.replace(/^@/, "").replaceAll("/", "--");
  return `${safeName}-${version}-LICENSE.txt`;
}

function packageRootForInput(repositoryRoot: string, input: string): string | undefined {
  const absoluteInput = resolve(repositoryRoot, input);
  const normalized = absoluteInput.split(sep).join("/");
  const marker = "/node_modules/";
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex < 0) return undefined;

  const prefix = normalized.slice(0, markerIndex + marker.length);
  const segments = normalized.slice(markerIndex + marker.length).split("/");
  const packageSegments = segments[0]?.startsWith("@")
    ? segments.slice(0, 2)
    : segments.slice(0, 1);
  if (packageSegments.length === 0 || packageSegments.some((segment) => segment.length === 0)) {
    throw new Error(`Cannot identify bundled package for ${input}.`);
  }
  return join(prefix, ...packageSegments);
}

async function findLicenseFile(packageRoot: string): Promise<string> {
  const entries = (await readdir(packageRoot)).filter((entry) =>
    /^licen[cs]e(?:[.\-_]|$)/i.test(entry),
  );
  entries.sort((left, right) => left.localeCompare(right));
  const filename = entries[0];
  if (!filename) throw new Error(`Bundled package at ${packageRoot} has no license file.`);
  return resolve(packageRoot, filename);
}

function asUtf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function bundledInputs(metafile: Metafile, bundle: string): readonly string[] {
  const inputs = new Set<string>();
  for (const output of Object.values(metafile.outputs)) {
    for (const [input, contribution] of Object.entries(output.inputs)) {
      if (contribution.bytesInOutput > 0) inputs.add(input);
    }
  }
  if (inputs.size === 0) {
    throw new Error(`CallFlow bundle ${bundle} has no byte-contributing metafile inputs.`);
  }
  return [...inputs].sort((left, right) => left.localeCompare(right));
}

export async function createCallFlowLicenseArtifacts(
  repositoryRoot: string,
  bundleMetafiles: readonly CallFlowBundleMetafile[],
): Promise<readonly CallFlowLicenseArtifact[]> {
  const approvedById = new Map(
    CALLFLOW_LICENSE_APPROVALS.map((approval) => [
      packageId(approval.name, approval.version),
      approval,
    ]),
  );
  const instances = new Map<
    string,
    {
      approval: LicenseApproval;
      bundles: Set<string>;
      licenseBodies: Uint8Array[];
      roots: Set<string>;
    }
  >();

  for (const { bundle, includePackageIds, metafile } of bundleMetafiles) {
    const includedIds = includePackageIds ? new Set(includePackageIds) : undefined;
    for (const id of includedIds ?? []) {
      if (!approvedById.has(id)) {
        throw new Error(`CallFlow shared-runtime filter contains unapproved dependency ${id}.`);
      }
    }
    for (const input of bundledInputs(metafile, bundle)) {
      const packageRoot = packageRootForInput(repositoryRoot, input);
      if (!packageRoot) continue;
      const metadata = JSON.parse(
        await readFile(resolve(packageRoot, "package.json"), "utf8"),
      ) as PackageMetadata;
      if (typeof metadata.name !== "string" || typeof metadata.version !== "string") {
        throw new Error(`Bundled package metadata is malformed at ${packageRoot}.`);
      }
      const id = packageId(metadata.name, metadata.version);
      if (includedIds && !includedIds.has(id)) continue;
      const approval = approvedById.get(id);
      if (!approval) throw new Error(`CallFlow bundle contains unapproved dependency ${id}.`);
      if (metadata.license !== approval.declaredLicense) {
        throw new Error(
          `${id} declares ${String(metadata.license)}; approved declaration is ${approval.declaredLicense}.`,
        );
      }

      const instance = instances.get(id) ?? {
        approval,
        bundles: new Set<string>(),
        licenseBodies: [],
        roots: new Set<string>(),
      };
      instance.bundles.add(bundle);
      if (!instance.roots.has(packageRoot)) {
        instance.roots.add(packageRoot);
        instance.licenseBodies.push(await readFile(await findLicenseFile(packageRoot)));
      }
      instances.set(id, instance);
    }
  }

  const missing = [...approvedById.keys()].filter((id) => !instances.has(id));
  if (missing.length > 0) {
    throw new Error(
      `Approved CallFlow dependencies are absent from its bundles: ${missing.join(", ")}.`,
    );
  }

  const artifacts: CallFlowLicenseArtifact[] = [];
  const packages = [...instances.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, instance]) => {
      const firstBody = instance.licenseBodies[0];
      if (!firstBody) throw new Error(`${id} has no readable license text.`);
      for (const body of instance.licenseBodies.slice(1)) {
        if (!Buffer.from(firstBody).equals(Buffer.from(body))) {
          throw new Error(`Physical copies of ${id} contain different license texts.`);
        }
      }
      const licenseDigest = createHash("sha256").update(firstBody).digest("hex");
      if (licenseDigest !== instance.approval.licenseDigest) {
        throw new Error(
          `${id} license text has digest ${licenseDigest}; approved digest is ${instance.approval.licenseDigest}.`,
        );
      }
      const filename = licenseFilename(instance.approval.name, instance.approval.version);
      artifacts.push({ path: filename, content: firstBody });
      return {
        name: instance.approval.name,
        version: instance.approval.version,
        declaredLicense: instance.approval.declaredLicense,
        selectedLicense: instance.approval.selectedLicense,
        licenseTextSha256: licenseDigest,
        licenseFile: filename,
        bundledIn: [...instance.bundles].sort((left, right) => left.localeCompare(right)),
      };
    });

  const sbom = {
    schema: "callflow/dependency-sbom-v1",
    packages,
  };
  artifacts.push({ path: "sbom.json", content: asUtf8(`${JSON.stringify(sbom, null, 2)}\n`) });

  const table = packages
    .map(
      (entry) =>
        `| \`${entry.name}\` | \`${entry.version}\` | ${entry.selectedLicense} | [license](./${entry.licenseFile}) |`,
    )
    .join("\n");
  const notices = `# CallFlow third-party notices

CallFlow's checked-in JavaScript bundles include the packages below. This inventory is generated from byte-contributing esbuild metafile inputs and must match the exact release allowlist. ELK is distributed under the EPL-2.0 option declared by its dual license.

The corresponding Source Code for the transformed elkjs 0.12.0 content is available under EPL-2.0 as described in [ELK-SOURCE-OFFER.md](./ELK-SOURCE-OFFER.md).

| Package | Version | Distributed license | Text |
| --- | --- | --- | --- |
${table}
`;
  artifacts.push({ path: "THIRD_PARTY_NOTICES.md", content: asUtf8(notices) });

  artifacts.push({
    path: "ELK-SOURCE-OFFER.md",
    content: asUtf8(`# ELK corresponding source

CallFlow's bundled layout worker contains transformed content from \`elkjs\` 0.12.0. The corresponding Source Code is available under the Eclipse Public License 2.0 from the exact npm source archive:

<https://registry.npmjs.org/elkjs/-/elkjs-0.12.0.tgz>

The upstream repository is <https://github.com/kieler/elkjs>. CallFlow elects the EPL-2.0 option from the package's declared \`EPL-2.0 OR GPL-3.0-or-later\` license and ships the complete license text alongside this notice.

The archive is the source published for the exact pinned package. CallFlow's deterministic transformation is defined by \`scripts/build.ts\` in <https://github.com/tjs-w/FlowZone>, and the generated bundle retains both complete upstream SPDX notice blocks byte-for-byte.
`),
  });

  return artifacts.sort((left, right) => left.path.localeCompare(right.path));
}
