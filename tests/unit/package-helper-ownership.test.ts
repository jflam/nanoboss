import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const REPO_ROOT = process.cwd();

type HelperFamily = {
  family: string;
  canonicalOwner: string;
  implementationNames: readonly string[];
  allowedImplementations: readonly HelperImplementationOwner[];
  publicExports: readonly PublicHelperExport[];
};

type HelperImplementationOwner = {
  packageName: string;
  path: string;
  reason: string;
};

type PublicHelperExport = {
  packageName: string;
  barrel: string;
  names: readonly string[];
  source: string;
  removalNote?: string;
};

const HELPER_FAMILIES = [
  {
    family: "data shape helpers",
    canonicalOwner: "@nanoboss/procedure-sdk",
    implementationNames: ["inferDataShape", "stringifyCompactShape"],
    allowedImplementations: [
      {
        packageName: "@nanoboss/procedure-sdk",
        path: "packages/procedure-sdk/src/data-shape.ts",
        reason: "Canonical procedure result shape helper owner.",
      },
    ],
    publicExports: [
      {
        packageName: "@nanoboss/procedure-sdk",
        barrel: "packages/procedure-sdk/src/index.ts",
        names: ["inferDataShape", "stringifyCompactShape"],
        source: "./data-shape.ts",
      },
    ],
  },
  {
    family: "text summarization",
    canonicalOwner: "@nanoboss/procedure-sdk",
    implementationNames: ["summarizeText"],
    allowedImplementations: [
      {
        packageName: "@nanoboss/procedure-sdk",
        path: "packages/procedure-sdk/src/text.ts",
        reason: "Canonical pure text helper owner.",
      },
    ],
    publicExports: [
      {
        packageName: "@nanoboss/procedure-sdk",
        barrel: "packages/procedure-sdk/src/index.ts",
        names: ["summarizeText"],
        source: "./text.ts",
      },
    ],
  },
  {
    family: "error formatting",
    canonicalOwner: "@nanoboss/procedure-sdk",
    implementationNames: ["formatErrorMessage"],
    allowedImplementations: [
      {
        packageName: "@nanoboss/procedure-sdk",
        path: "packages/procedure-sdk/src/error-format.ts",
        reason: "Canonical pure error formatting helper owner.",
      },
    ],
    publicExports: [
      {
        packageName: "@nanoboss/procedure-sdk",
        barrel: "packages/procedure-sdk/src/index.ts",
        names: ["formatErrorMessage"],
        source: "./error-format.ts",
      },
    ],
  },
  {
    family: "tool payload normalization",
    canonicalOwner: "@nanoboss/procedure-sdk",
    implementationNames: [
      "normalizeToolName",
      "normalizeToolInputPayload",
      "normalizeToolResultPayload",
      "extractToolErrorText",
      "extractPathLike",
      "firstString",
      "firstNumber",
      "stringifyValue",
    ],
    allowedImplementations: [
      {
        packageName: "@nanoboss/procedure-sdk",
        path: "packages/procedure-sdk/src/tool-payload-normalizer.ts",
        reason: "Canonical adapter-neutral tool payload normalization owner.",
      },
    ],
    publicExports: [
      {
        packageName: "@nanoboss/procedure-sdk",
        barrel: "packages/procedure-sdk/src/index.ts",
        names: [
          "asRecord",
          "extractPathLike",
          "extractToolErrorText",
          "firstNumber",
          "firstString",
          "normalizeToolInputPayload",
          "normalizeToolName",
          "normalizeToolResultPayload",
          "stringifyValue",
          "NormalizedToolPayload",
          "ToolPayloadIdentity",
        ],
        source: "./tool-payload-normalizer.ts",
      },
    ],
  },
  {
    family: "self-command resolution",
    canonicalOwner: "@nanoboss/app-support",
    implementationNames: ["resolveSelfCommand", "resolveSelfCommandWithRuntime"],
    allowedImplementations: [
      {
        packageName: "@nanoboss/app-support",
        path: "packages/app-support/src/self-command.ts",
        reason: "Canonical low-level process entrypoint helper owner.",
      },
    ],
    publicExports: [
      {
        packageName: "@nanoboss/app-support",
        barrel: "packages/app-support/src/index.ts",
        names: ["resolveSelfCommand", "resolveSelfCommandWithRuntime", "SelfCommand", "SelfCommandRuntime"],
        source: "./self-command.ts",
      },
    ],
  },
  {
    family: "timing traces",
    canonicalOwner: "@nanoboss/app-support",
    implementationNames: ["appendTimingTraceEvent", "createRunTimingTrace"],
    allowedImplementations: [
      {
        packageName: "@nanoboss/app-support",
        path: "packages/app-support/src/timing-trace.ts",
        reason: "Canonical low-level timing trace writer owner.",
      },
    ],
    publicExports: [
      {
        packageName: "@nanoboss/app-support",
        barrel: "packages/app-support/src/index.ts",
        names: ["appendTimingTraceEvent", "createRunTimingTrace", "RunTimingTrace"],
        source: "./timing-trace.ts",
      },
    ],
  },
] as const satisfies readonly HelperFamily[];

const GUARDED_HELPER_NAMES: ReadonlySet<string> = new Set(
  HELPER_FAMILIES.flatMap((family) => [...family.implementationNames]),
);

const GUARDED_PUBLIC_HELPER_NAMES: ReadonlySet<string> = new Set(
  HELPER_FAMILIES.flatMap((family) => family.publicExports.flatMap((publicExport) => [...publicExport.names])),
);

test("keeps duplicate helper families owned by their canonical package", () => {
  for (const family of HELPER_FAMILIES) {
    expect(family.canonicalOwner).toStartWith("@nanoboss/");

    for (const implementation of family.allowedImplementations) {
      expect(implementation.packageName).toBe(family.canonicalOwner);
      expect(implementation.packageName === packageNameFromPackagePath(implementation.path)).toBe(true);
      expect(implementation.reason.length).toBeGreaterThan(0);
      expect(existsSync(join(REPO_ROOT, implementation.path))).toBe(true);
    }
  }

  const implementations = collectPackageHelperImplementations();

  for (const family of HELPER_FAMILIES) {
    const allowedFiles = new Set(family.allowedImplementations.map((implementation) => implementation.path));
    const actualFiles = new Set(
      implementations
        .filter((implementation) => includesString(family.implementationNames, implementation.name))
        .map((implementation) => implementation.path),
    );

    expect([...actualFiles].sort()).toEqual([...allowedFiles].sort());
  }
});

test("keeps helper public exports intentional", () => {
  const expectedExports = new Map<string, PublicHelperExport>();
  for (const family of HELPER_FAMILIES) {
    for (const publicExport of family.publicExports) {
      const key = publicExportKey(publicExport.packageName, publicExport.names, publicExport.source);
      expectedExports.set(key, publicExport);
    }
  }

  const actualExports = collectPackageBarrelExports();
  expect([...actualExports.keys()].sort()).toEqual([...expectedExports.keys()].sort());

  for (const publicExport of expectedExports.values()) {
    const barrelSource = readFileSync(join(REPO_ROOT, publicExport.barrel), "utf8");

    if (publicExport.removalNote !== undefined) {
      expect(barrelSource).toContain(publicExport.removalNote);
    }
  }
});

type HelperImplementation = {
  name: string;
  path: string;
};

function collectPackageHelperImplementations(): HelperImplementation[] {
  const implementations: HelperImplementation[] = [];

  for (const path of listPackageSourceFiles()) {
    const relativePath = relative(REPO_ROOT, path).replaceAll("\\", "/");
    const source = readFileSync(path, "utf8");
    const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

    const visit = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name !== undefined && GUARDED_HELPER_NAMES.has(node.name.text)) {
        implementations.push({ name: node.name.text, path: relativePath });
      }

      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && GUARDED_HELPER_NAMES.has(node.name.text)) {
        if (
          node.initializer !== undefined &&
          (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
        ) {
          implementations.push({ name: node.name.text, path: relativePath });
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  return implementations.sort((left, right) => left.path.localeCompare(right.path) || left.name.localeCompare(right.name));
}

function collectPackageBarrelExports(): Map<string, PublicHelperExport> {
  const publicExports = new Map<string, PublicHelperExport>();

  for (const barrel of listPackageBarrelFiles()) {
    const source = readFileSync(barrel, "utf8");
    const sourceFile = ts.createSourceFile(barrel, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const packageName = `@nanoboss/${relative(REPO_ROOT, barrel).replaceAll("\\", "/").split("/")[1]}`;

    for (const statement of sourceFile.statements) {
      if (
        !ts.isExportDeclaration(statement) ||
        statement.exportClause === undefined ||
        !ts.isNamedExports(statement.exportClause) ||
        statement.moduleSpecifier === undefined ||
        !ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        continue;
      }

      const guardedNames = statement.exportClause.elements
        .map((element) => element.name.text)
        .filter((name) => isGuardedPublicHelperName(name))
        .sort();

      if (guardedNames.length === 0) {
        continue;
      }

      const publicExport = {
        packageName,
        barrel: relative(REPO_ROOT, barrel).replaceAll("\\", "/"),
        names: guardedNames,
        source: statement.moduleSpecifier.text,
      } satisfies PublicHelperExport;
      publicExports.set(publicExportKey(publicExport.packageName, publicExport.names, publicExport.source), publicExport);
    }
  }

  return publicExports;
}

function isGuardedPublicHelperName(name: string): boolean {
  return GUARDED_PUBLIC_HELPER_NAMES.has(name);
}

function includesString(values: readonly string[], value: string): boolean {
  return values.includes(value);
}

function packageNameFromPackagePath(path: string): string {
  const match = /^packages\/([^/]+)\//.exec(path);
  expect(match).not.toBeNull();
  return `@nanoboss/${match?.[1] ?? ""}`;
}

function publicExportKey(packageName: string, names: readonly string[], source: string): string {
  return `${packageName} exports ${[...names].sort().join(",")} from ${source}`;
}

function listPackageBarrelFiles(): string[] {
  return readdirSync(join(REPO_ROOT, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(REPO_ROOT, "packages", entry.name, "src", "index.ts"))
    .filter((path) => existsSync(path))
    .sort();
}

function listPackageSourceFiles(): string[] {
  return listTypeScriptFilesIn(join(REPO_ROOT, "packages"))
    .filter((path) => /^packages\/[^/]+\/src\//.test(relative(REPO_ROOT, path).replaceAll("\\", "/")))
    .filter((path) => !path.endsWith(".d.ts"));
}

function listTypeScriptFilesIn(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }

  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "dist" || entry.name === "node_modules") {
        continue;
      }

      files.push(...listTypeScriptFilesIn(path));
      continue;
    }

    if (entry.isFile() && path.endsWith(".ts")) {
      files.push(path);
    }
  }

  return files.sort((left, right) => relative(REPO_ROOT, left).localeCompare(relative(REPO_ROOT, right)));
}
