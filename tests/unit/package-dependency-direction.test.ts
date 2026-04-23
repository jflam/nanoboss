import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const PACKAGE_NAMES = [
  "adapters-acp-server",
  "adapters-http",
  "adapters-mcp",
  "adapters-tui",
  "agent-acp",
  "app-runtime",
  "app-support",
  "contracts",
  "procedure-catalog",
  "procedure-engine",
  "procedure-sdk",
  "store",
  "tui-extension-catalog",
  "tui-extension-sdk",
] as const;

type PackageName = (typeof PACKAGE_NAMES)[number];

const REPO_ROOT = process.cwd();
const PACKAGE_SCOPE = "@nanoboss/";

const ALLOWED_LAYERING: Record<PackageName, readonly PackageName[]> = {
  "adapters-acp-server": [
    "agent-acp",
    "adapters-mcp",
    "app-runtime",
    "app-support",
    "contracts",
    "procedure-engine",
  ],
  "adapters-http": ["agent-acp", "app-runtime", "app-support", "procedure-sdk"],
  "adapters-mcp": ["app-runtime", "app-support", "contracts", "procedure-sdk", "store"],
  "adapters-tui": [
    "adapters-http",
    "agent-acp",
    "app-support",
    "contracts",
    "procedure-engine",
    "procedure-sdk",
    "store",
    "tui-extension-catalog",
    "tui-extension-sdk",
  ],
  "agent-acp": ["contracts", "procedure-sdk", "store"],
  "app-runtime": [
    "agent-acp",
    "app-support",
    "contracts",
    "procedure-catalog",
    "procedure-engine",
    "procedure-sdk",
    "store",
  ],
  "app-support": [],
  contracts: [],
  "procedure-catalog": ["app-support", "procedure-sdk"],
  "procedure-engine": ["agent-acp", "contracts", "procedure-catalog", "procedure-sdk", "store"],
  "procedure-sdk": ["contracts"],
  store: ["app-support", "contracts", "procedure-sdk"],
  "tui-extension-catalog": ["app-support", "tui-extension-sdk"],
  "tui-extension-sdk": ["procedure-sdk"],
};

for (const packageName of PACKAGE_NAMES) {
  test(`${packageName} only uses declared workspace dependencies`, () => {
    const declaredDependencies = readDeclaredWorkspaceDependencies(packageName);
    const violations = collectWorkspaceImports(packageName)
      .flatMap((usage) => {
        if (usage.targetPackage === packageName) {
          return [];
        }

        if (!isWorkspacePackageName(usage.targetPackage)) {
          return [
            `${packageName} imports unknown workspace package ${formatWorkspaceDependency(usage.targetPackage)} in ${usage.location}`,
          ];
        }

        if (declaredDependencies.has(usage.targetPackage)) {
          return [];
        }

        return [
          `${packageName} uses undeclared ${formatWorkspaceDependency(usage.targetPackage)} in ${usage.location}`,
        ];
      })
      .sort();

    expect(violations).toEqual([]);
  });

  test(`${packageName} only declares allowed workspace dependencies`, () => {
    const allowedDependencies = new Set(ALLOWED_LAYERING[packageName]);
    const violations = [...readDeclaredWorkspaceDependencies(packageName)]
      .flatMap((dependency) => {
        if (!isWorkspacePackageName(dependency)) {
          return [
            `${packageName} declares unknown workspace package ${formatWorkspaceDependency(dependency)} in packages/${packageName}/package.json`,
          ];
        }

        if (allowedDependencies.has(dependency)) {
          return [];
        }

        return [
          `${packageName} declares disallowed ${formatWorkspaceDependency(dependency)} in packages/${packageName}/package.json; allowed: ${formatDependencyList(ALLOWED_LAYERING[packageName])}`,
        ];
      })
      .sort();

    expect(violations).toEqual([]);
  });
}

test("allowed workspace layering graph is acyclic", () => {
  expect(findAllowedLayeringCycles()).toEqual([]);
});

function readDeclaredWorkspaceDependencies(packageName: PackageName): Set<string> {
  const packageJson = JSON.parse(
    readFileSync(join(REPO_ROOT, "packages", packageName, "package.json"), "utf8"),
  ) as {
    dependencies?: Record<string, string>;
  };

  const dependencies = new Set<string>();
  for (const specifier of Object.keys(packageJson.dependencies ?? {})) {
    const dependency = parseWorkspaceDependencySpecifier(specifier);
    if (dependency === null || dependency === packageName) {
      continue;
    }
    dependencies.add(dependency);
  }

  return dependencies;
}

type WorkspaceImportUsage = {
  location: string;
  targetPackage: string;
};

function collectWorkspaceImports(packageName: PackageName): WorkspaceImportUsage[] {
  const packageRoot = join(REPO_ROOT, "packages", packageName);
  const files = [
    ...listTypeScriptFilesIn(join(packageRoot, "src")),
    ...listTypeScriptFilesIn(join(packageRoot, "tests")),
  ];

  const usages: WorkspaceImportUsage[] = [];
  for (const path of files) {
    const source = readFileSync(path, "utf8");
    const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const relativePath = relative(REPO_ROOT, path).replaceAll("\\", "/");

    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const dependency = parseWorkspaceDependencySpecifier(node.moduleSpecifier.text);
        if (dependency !== null) {
          usages.push({
            location: formatLocation(relativePath, sourceFile, node.moduleSpecifier.getStart(sourceFile)),
            targetPackage: dependency,
          });
        }
      }

      const importArgument = ts.isCallExpression(node) ? node.arguments[0] : undefined;
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments.length === 1 &&
        importArgument !== undefined &&
        ts.isStringLiteralLike(importArgument)
      ) {
        const dependency = parseWorkspaceDependencySpecifier(importArgument.text);
        if (dependency !== null) {
          usages.push({
            location: formatLocation(relativePath, sourceFile, importArgument.getStart(sourceFile)),
            targetPackage: dependency,
          });
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  return usages.sort((left, right) => left.location.localeCompare(right.location) || left.targetPackage.localeCompare(right.targetPackage));
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

function parseWorkspaceDependencySpecifier(specifier: string): string | null {
  if (!specifier.startsWith(PACKAGE_SCOPE)) {
    return null;
  }

  const dependency = specifier.slice(PACKAGE_SCOPE.length).split("/")[0];
  return dependency && dependency.length > 0 ? dependency : null;
}

function isWorkspacePackageName(value: string): value is PackageName {
  return (PACKAGE_NAMES as readonly string[]).includes(value);
}

function isValidatedPackageName(value: string): value is PackageName {
  return (PACKAGE_NAMES as readonly string[]).includes(value);
}

function formatWorkspaceDependency(packageName: string): string {
  return `${PACKAGE_SCOPE}${packageName}`;
}

function formatDependencyList(packageNames: readonly PackageName[]): string {
  return packageNames.length === 0 ? "(none)" : packageNames.map(formatWorkspaceDependency).join(", ");
}

function formatLocation(relativePath: string, sourceFile: ts.SourceFile, position: number): string {
  const { line } = sourceFile.getLineAndCharacterOfPosition(position);
  return `${relativePath}:${line + 1}`;
}

function findAllowedLayeringCycles(): string[] {
  const visited = new Set<PackageName>();
  const inStack = new Set<PackageName>();
  const stack: PackageName[] = [];
  const cycles = new Set<string>();

  const visit = (packageName: PackageName): void => {
    if (inStack.has(packageName)) {
      const cycleStartIndex = stack.indexOf(packageName);
      const cyclePath = [...stack.slice(cycleStartIndex), packageName]
        .map(formatWorkspaceDependency)
        .join(" -> ");
      cycles.add(cyclePath);
      return;
    }

    if (visited.has(packageName)) {
      return;
    }

    visited.add(packageName);
    inStack.add(packageName);
    stack.push(packageName);

    for (const dependency of ALLOWED_LAYERING[packageName]) {
      if (isValidatedPackageName(dependency)) {
        visit(dependency);
      }
    }

    stack.pop();
    inStack.delete(packageName);
  };

  for (const packageName of PACKAGE_NAMES) {
    visit(packageName);
  }

  return [...cycles].sort();
}
