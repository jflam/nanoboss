import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { getNanobossRuntimeDir } from "./nanoboss-home.ts";

export async function withDiskBuildNodeModules<T>(workspaceRoot: string, run: () => Promise<T>): Promise<T> {
  const nodeModulesPath = join(workspaceRoot, "node_modules");
  const srcPath = join(workspaceRoot, "src");
  const packagesPath = join(workspaceRoot, "packages");
  const runtimeSourcePath = resolveDiskBuildSourcePath();
  const runtimePackagesPath = resolveDiskBuildPackagesPath();
  const runtimeNodeModulesPaths = resolveDiskBuildNodeModulesPaths();
  const workspacePackageSourcePaths = [packagesPath, runtimePackagesPath]
    .filter((path, index, array): path is string => Boolean(path) && array.indexOf(path) === index);

  return await withTemporaryNodeModulesOverlays(nodeModulesPath, runtimeNodeModulesPaths, async () =>
    await withTemporaryWorkspacePackageOverlays(nodeModulesPath, workspacePackageSourcePaths, async () =>
      await withOptionalTemporarySymlink(srcPath, runtimeSourcePath, async () =>
        await withOptionalTemporarySymlink(packagesPath, runtimePackagesPath, run)
      )
    )
  );
}

export function resolveDiskBuildRoot(path: string, entryDirHints: readonly string[]): string {
  const fileDir = dirname(resolve(path));

  for (let current = fileDir; ; current = dirname(current)) {
    const currentBaseName = basename(current);
    if (currentBaseName === "packages") {
      return dirname(current);
    }

    if (entryDirHints.includes(currentBaseName)) {
      const parent = dirname(current);
      return basename(parent) === ".nanoboss" ? dirname(parent) : parent;
    }

    if (existsSync(join(current, "tsconfig.json")) || existsSync(join(current, "node_modules"))) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      return fileDir;
    }
  }
}

function resolveDiskBuildNodeModulesPaths(): string[] {
  const sourceNodeModulesPath = resolveSourceCheckoutPath("node_modules");
  const installedRuntimeNodeModulesPath = join(getNanobossRuntimeDir(), "node_modules");
  const paths = [sourceNodeModulesPath, installedRuntimeNodeModulesPath]
    .filter((path, index, array) => existsSync(path) && array.indexOf(path) === index);

  if (paths.length > 0) {
    return paths;
  }

  throw new Error(
    `Disk module build runtime packages are not available. Expected ${installedRuntimeNodeModulesPath} or ${sourceNodeModulesPath}. Rebuild nanoboss to install its typia runtime packages.`,
  );
}

function resolveDiskBuildSourcePath(): string | undefined {
  const sourcePath = resolveSourceCheckoutPath("src");
  if (existsSync(sourcePath)) {
    return sourcePath;
  }

  const installedRuntimeSourcePath = join(getNanobossRuntimeDir(), "src");
  return existsSync(installedRuntimeSourcePath) ? installedRuntimeSourcePath : undefined;
}

function resolveDiskBuildPackagesPath(): string | undefined {
  const sourcePackagesPath = resolveSourceCheckoutPath("packages");
  if (existsSync(sourcePackagesPath)) {
    return sourcePackagesPath;
  }

  const installedRuntimePackagesPath = join(getNanobossRuntimeDir(), "packages");
  return existsSync(installedRuntimePackagesPath) ? installedRuntimePackagesPath : undefined;
}

function resolveSourceCheckoutPath(...segments: string[]): string {
  return resolve(import.meta.dir, "..", "..", "..", ...segments);
}

function isSymlinkPath(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

async function withTemporarySymlink<T>(targetPath: string, sourcePath: string, run: () => Promise<T>): Promise<T> {
  let createdSymlink = false;

  try {
    symlinkSync(sourcePath, targetPath, "dir");
    createdSymlink = true;
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") {
      throw error;
    }
  }

  try {
    return await run();
  } finally {
    if (createdSymlink && isSymlinkPath(targetPath)) {
      rmSync(targetPath, { recursive: true, force: true });
    }
  }
}

async function withTemporaryNodeModulesOverlays<T>(
  targetNodeModulesPath: string,
  sourceNodeModulesPaths: string[],
  run: () => Promise<T>,
): Promise<T> {
  let createdNodeModulesDir = false;
  if (!existsSync(targetNodeModulesPath)) {
    mkdirSync(targetNodeModulesPath, { recursive: true });
    createdNodeModulesDir = true;
  }

  const createdPaths = sourceNodeModulesPaths.flatMap((sourceNodeModulesPath) =>
    linkMissingNodeModulesEntries(targetNodeModulesPath, sourceNodeModulesPath)
  );

  try {
    return await run();
  } finally {
    for (const createdPath of createdPaths.reverse()) {
      if (!existsSync(createdPath)) {
        continue;
      }

      if (isSymlinkPath(createdPath)) {
        rmSync(createdPath, { recursive: true, force: true });
        continue;
      }

      try {
        if (lstatSync(createdPath).isDirectory() && readdirSync(createdPath).length === 0) {
          rmSync(createdPath, { recursive: true, force: true });
        }
      } catch {
        // Ignore cleanup errors in the temporary overlay path.
      }
    }

    if (createdNodeModulesDir && existsSync(targetNodeModulesPath)) {
      try {
        if (readdirSync(targetNodeModulesPath).length === 0) {
          rmSync(targetNodeModulesPath, { recursive: true, force: true });
        }
      } catch {
        // Ignore cleanup errors in the temporary overlay path.
      }
    }
  }
}

async function withTemporaryWorkspacePackageOverlays<T>(
  targetNodeModulesPath: string,
  sourcePackagesPaths: string[],
  run: () => Promise<T>,
): Promise<T> {
  const createdPaths = sourcePackagesPaths.flatMap((sourcePackagesPath) =>
    linkMissingWorkspacePackages(targetNodeModulesPath, sourcePackagesPath)
  );

  try {
    return await run();
  } finally {
    for (const createdPath of createdPaths.reverse()) {
      if (existsSync(createdPath) && isSymlinkPath(createdPath)) {
        rmSync(createdPath, { recursive: true, force: true });
      }
    }

    removeEmptyAncestorDirectories(targetNodeModulesPath, createdPaths);
  }
}

function linkMissingNodeModulesEntries(targetDir: string, sourceDir: string): string[] {
  if (!existsSync(sourceDir)) {
    return [];
  }

  const createdPaths: string[] = [];
  const entries = readdirSync(sourceDir, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const sourcePath = join(sourceDir, entry.name);
    const targetPath = join(targetDir, entry.name);

    if (entry.isDirectory() && entry.name.startsWith("@")) {
      if (existsSync(targetPath) && !lstatSync(targetPath).isDirectory()) {
        continue;
      }

      if (!existsSync(targetPath)) {
        mkdirSync(targetPath, { recursive: true });
        createdPaths.push(targetPath);
      }

      createdPaths.push(...linkMissingNodeModulesEntries(targetPath, sourcePath));
      continue;
    }

    if (existsSync(targetPath)) {
      continue;
    }

    symlinkSync(sourcePath, targetPath, entry.isDirectory() ? "dir" : "file");
    createdPaths.push(targetPath);
  }

  return createdPaths;
}

function linkMissingWorkspacePackages(targetNodeModulesDir: string, sourcePackagesDir: string): string[] {
  if (!existsSync(sourcePackagesDir)) {
    return [];
  }

  const createdPaths: string[] = [];
  const entries = readdirSync(sourcePackagesDir, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const sourcePackageDir = join(sourcePackagesDir, entry.name);
    const packageName = readWorkspacePackageName(sourcePackageDir);
    if (!packageName) {
      continue;
    }

    const targetPackageDir = join(targetNodeModulesDir, ...packageName.split("/"));
    if (existsSync(targetPackageDir)) {
      continue;
    }

    mkdirSync(dirname(targetPackageDir), { recursive: true });
    symlinkSync(sourcePackageDir, targetPackageDir, "dir");
    createdPaths.push(targetPackageDir);
  }

  return createdPaths;
}

function readWorkspacePackageName(packageDir: string): string | undefined {
  try {
    const packageJson = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as { name?: unknown };
    return typeof packageJson.name === "string" && packageJson.name.trim().length > 0
      ? packageJson.name.trim()
      : undefined;
  } catch {
    return undefined;
  }
}

function removeEmptyAncestorDirectories(targetNodeModulesPath: string, createdPaths: string[]): void {
  const candidateDirs = [...new Set(
    createdPaths
      .map((createdPath) => dirname(createdPath))
      .filter((dir) => dir !== targetNodeModulesPath)
      .sort((left, right) => right.length - left.length),
  )];

  for (const candidateDir of candidateDirs) {
    if (!existsSync(candidateDir) || isSymlinkPath(candidateDir)) {
      continue;
    }

    try {
      if (readdirSync(candidateDir).length === 0) {
        rmSync(candidateDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup errors in temporary package alias directories.
    }
  }
}

async function withOptionalTemporarySymlink<T>(
  targetPath: string,
  sourcePath: string | undefined,
  run: () => Promise<T>,
): Promise<T> {
  if (!sourcePath || existsSync(targetPath)) {
    return await run();
  }

  return await withTemporarySymlink(targetPath, sourcePath, run);
}
