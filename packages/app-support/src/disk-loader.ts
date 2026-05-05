import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { getNanobossRuntimeDir } from "./nanoboss-home.ts";
import { createTypiaBunPlugin } from "./typia-bun-plugin.ts";
import {
  extractBuildLogs,
  formatDiskBuildFailure,
} from "./disk-build-diagnostics.ts";
import {
  resolveDiskModuleSourceGraph,
} from "./disk-source-graph.ts";
import {
  resolveDiskBuildRoot,
  withDiskBuildNodeModules,
} from "./disk-build-workspace.ts";

const DISK_MODULE_BUILD_CACHE_VERSION = 1;
export type { DiskModuleSourceFile } from "./disk-source-graph.ts";

export interface DiscoverDiskModulesParams<M> {
  root: string;
  readMetadata(params: { path: string; source: string }): M | undefined;
}

export interface DiscoveredDiskModule<M> {
  path: string;
  metadata: M;
}

export function discoverDiskModules<M>(
  params: DiscoverDiskModulesParams<M>,
): DiscoveredDiskModule<M>[] {
  if (!existsSync(params.root)) {
    return [];
  }

  return listDiskSourcePaths(params.root)
    .map((path): DiscoveredDiskModule<M> | undefined => {
      const source = readFileSync(path, "utf8");
      const metadata = params.readMetadata({ path, source });
      return metadata === undefined ? undefined : { path, metadata };
    })
    .filter((entry): entry is DiscoveredDiskModule<M> => entry !== undefined);
}

export interface LoadDiskModuleParams {
  path: string;
  /**
   * Sub-directory name under the shared ~/.nanoboss/runtime/ cache to use for
   * compiled module outputs. Different callers (e.g., procedures vs.
   * extensions) use distinct namespaces so caches do not interfere.
   */
  cacheNamespace: string;
  /**
   * Directory basenames that indicate a disk-module entry when walking up the
   * filesystem to find the workspace root used to locate node_modules. For
   * example, procedures pass `"procedures"` so that entries under
   * `<repo>/.nanoboss/procedures/**` resolve to `<repo>`.
   */
  entryDirHints?: readonly string[];
}

export async function loadDiskModule(params: LoadDiskModuleParams): Promise<unknown> {
  const moduleUrl = await buildDiskModule(params);
  return await import(moduleUrl);
}

export function getDiskModuleDefaultExport(module: unknown): unknown {
  if (!module || typeof module !== "object" || !("default" in module)) {
    return undefined;
  }
  return (module as { default: unknown }).default;
}

async function buildDiskModule(params: LoadDiskModuleParams): Promise<string> {
  const resolvedWorkspaceRoot = resolveDiskBuildRoot(params.path, params.entryDirHints ?? []);
  return await withDiskBuildNodeModules(resolvedWorkspaceRoot, async () => {
    const cacheKey = buildDiskModuleCacheKey(params.path, resolvedWorkspaceRoot);
    const cacheDir = join(getDiskModuleBuildCacheDir(params.cacheNamespace), cacheKey);
    const cacheModulePath = join(cacheDir, "module.js");
    if (!existsSync(cacheModulePath)) {
      const outdir = mkdtempSync(join(tmpdir(), "nanoboss-disk-module-"));
      try {
        let result: Awaited<ReturnType<typeof Bun.build>>;
        try {
          result = await Bun.build({
            entrypoints: [params.path],
            outdir,
            format: "esm",
            plugins: [createTypiaBunPlugin()],
            sourcemap: "inline",
            target: "bun",
          });
        } catch (error) {
          throw new Error(formatDiskBuildFailure(params.path, extractBuildLogs(error)), { cause: error });
        }

        if (!result.success) {
          throw new Error(formatDiskBuildFailure(params.path, result.logs), { cause: result });
        }

        const output = result.outputs[0];
        if (!output) {
          throw new Error(`Disk module build produced no output for ${params.path}`);
        }

        mkdirSync(cacheDir, { recursive: true });
        copyFileSync(output.path, cacheModulePath);
      } finally {
        rmSync(outdir, { recursive: true, force: true });
      }
    }

    return `${pathToFileURL(cacheModulePath).href}?v=${cacheKey}`;
  });
}

function getDiskModuleBuildCacheDir(cacheNamespace: string): string {
  return join(getNanobossRuntimeDir(), cacheNamespace);
}

function buildDiskModuleCacheKey(path: string, workspaceRoot: string): string {
  const hash = createHash("sha256");
  hash.update(`disk-module-cache-version:${String(DISK_MODULE_BUILD_CACHE_VERSION)}\n`);
  hash.update(`bun-version:${Bun.version}\n`);

  for (const sourceFile of resolveDiskModuleSourceGraph(path)) {
    hash.update(relative(workspaceRoot, sourceFile.path));
    hash.update("\n");
    hash.update(sourceFile.contents);
    hash.update("\n");
  }

  return hash.digest("hex").slice(0, 24);
}

function listDiskSourcePaths(rootDir: string): string[] {
  const files: string[] = [];
  walkDiskSourcePaths(resolve(rootDir), files);
  return files;
}

function walkDiskSourcePaths(dir: string, files: string[]): void {
  const entries = readdirSync(dir, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) {
      continue;
    }

    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDiskSourcePaths(entryPath, files);
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(entryPath);
    }
  }
}
