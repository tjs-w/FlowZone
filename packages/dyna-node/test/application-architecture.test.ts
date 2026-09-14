import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "../../..");

const productionRoots = [
  ...readdirSync(resolve(repositoryRoot, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => resolve(repositoryRoot, "packages", entry.name, "src"))
    .filter((path) => existsSync(path)),
  resolve(repositoryRoot, "server/src"),
];

const adapterPaths = [
  "server/src/dyna.ts",
  "packages/mcp-server/src/plugins/dyna.ts",
  "server/src/publish.ts",
] as const;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && /\.[cm]?[jt]sx?$/u.test(entry.name) ? [path] : [];
  });
}

function moduleSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const importPattern = /(?:\bfrom\s+|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)["']([^"']+)["']/gu;
  for (const match of source.matchAll(importPattern)) {
    if (match[1] !== undefined) specifiers.push(match[1]);
  }
  return specifiers;
}

function readSource(path: string): string {
  return readFileSync(resolve(repositoryRoot, path), "utf8");
}

describe("Dyna application architecture", () => {
  test("keeps SQLite private to the repository implementation", () => {
    const sqliteImporters = productionRoots
      .flatMap((root) => sourceFiles(root))
      .filter((path) => moduleSpecifiers(readFileSync(path, "utf8")).includes("node:sqlite"))
      .map((path) => relative(repositoryRoot, path))
      .sort();

    expect(sqliteImporters).toEqual(["packages/dyna-node/src/repository.ts"]);
  });

  test("keeps protocol adapters on the application-service boundary", () => {
    for (const adapterPath of adapterPaths) {
      const source = readSource(adapterPath);
      const persistenceImports = moduleSpecifiers(source).filter((specifier) =>
        /(?:^|\/)(?:repository|store)(?:\.[cm]?[jt]s)?$/u.test(specifier),
      );

      expect(persistenceImports, `${adapterPath} imports persistence directly`).toEqual([]);
      expect(source, `${adapterPath} names a persistence implementation`).not.toMatch(
        /\b(?:DynaRepository|SqliteDynaRepository|DynaStore)\b/u,
      );
      expect(source, `${adapterPath} accesses a public store property`).not.toMatch(
        /(?:\.\s*store\b|\[\s*["']store["']\s*\])/u,
      );
    }
  });

  test("keeps the application service transport-neutral and SQL-free", () => {
    const service = readSource("packages/dyna-node/src/service.ts");
    const forbiddenDependencies = moduleSpecifiers(service).filter(
      (specifier) =>
        /^(?:node:(?:child_process|http|https|process|sqlite)|@modelcontextprotocol\/)/u.test(
          specifier,
        ) || /^(?:http|https|undici)$/u.test(specifier),
    );

    expect(forbiddenDependencies).toEqual([]);
    expect(service).not.toMatch(/\b(?:process\s*\.|fetch\s*\(|DatabaseSync\b)/u);
    expect(service).not.toMatch(
      /\b(?:SELECT|INSERT|UPDATE|DELETE|CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE|PRAGMA|BEGIN\s+(?:IMMEDIATE|TRANSACTION)|COMMIT|ROLLBACK|VACUUM)\b/u,
    );
  });

  test("implements canonical work commands without legacy CLI repository calls", () => {
    const service = readSource("packages/dyna-node/src/service.ts");

    expect(service).not.toMatch(/\.\s*[A-Za-z_$][\w$]*FromCli\s*\(/u);
  });

  test("keeps the repository port narrow and prevents high-level direct delegation", () => {
    const service = readSource("packages/dyna-node/src/service.ts");
    const repository = readSource("packages/dyna-node/src/repository.ts");
    const repositoryPort = /export interface DynaRepository \{(?<body>[\s\S]*?)\n\}/u.exec(
      repository,
    )?.groups?.["body"];
    expect(repositoryPort).toBeDefined();
    const portMembers = [
      ...(repositoryPort ?? "").matchAll(/^\s{2}([A-Za-z_$][\w$]*)(?:<|:|\()/gmu),
    ]
      .map((match) => match[1])
      .filter((name): name is string => name !== undefined)
      .sort();
    expect(portMembers).toEqual(["backup", "close", "read", "write"]);

    const directRepositoryCalls = [
      ...service.matchAll(/this\.#repository\.([A-Za-z_$][\w$]*)\s*\(/gu),
    ]
      .map((match) => match[1])
      .filter((name): name is string => name !== undefined);
    expect(
      directRepositoryCalls.filter(
        (method) => !["backup", "close", "read", "write"].includes(method),
      ),
    ).toEqual([]);
  });

  test("keeps lifecycle, priority, and blocker projection out of persistence", () => {
    const repository = readSource("packages/dyna-node/src/repository.ts");
    const repositoryImports = moduleSpecifiers(repository);
    const derivedSqlIdentifiers = [
      ...new Set(
        [
          ...repository.matchAll(
            /\b(?:effective_workflow_state|effective_priority|work_blocked)\b/gu,
          ),
        ].map(([identifier]) => identifier),
      ),
    ].sort();
    const projectorImports = repositoryImports.filter((specifier) =>
      /(?:^|\/)projector\.(?:js|ts)$/u.test(specifier),
    );

    expect(derivedSqlIdentifiers).toEqual([]);
    expect(projectorImports).toEqual([]);
  });
});
