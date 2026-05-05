import UnpluginTypia from "@ryoppippi/unplugin-typia/bun";
import { resolveNanobossInstallDir } from "@nanoboss/app-support";
import { getProcedureRuntimeDir } from "@nanoboss/procedure-catalog";
import { execFileSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  attributeSourceMapBytes,
  formatByteSize,
  summarizeBundledSources,
} from "./src/dev/build-size-report.ts";

const outfile = "./dist/nanoboss";
const buildCommit = resolveBuildCommit();

const result = await Bun.build({
  ...createBaseBuildConfig(buildCommit),
  compile: {
    outfile,
    autoloadBunfig: false,
    autoloadTsconfig: false,
    autoloadPackageJson: false,
  },
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  process.exitCode = 1;
} else {
  const installDir = resolveNanobossInstallDir({
    overrideDir: Bun.env.NANOBOSS_INSTALL_DIR,
  });
  const target = join(installDir, "nanoboss");
  const typiaRuntimeNodeModulesTarget = join(getProcedureRuntimeDir(), "node_modules");
  const procedureRuntimeSourceTarget = join(getProcedureRuntimeDir(), "src");
  const procedureRuntimePackagesTarget = join(getProcedureRuntimeDir(), "packages");
  const sizeReport = await collectBuildSizeReport(buildCommit);

  mkdirSync(dirname(outfile), { recursive: true });
  mkdirSync(installDir, { recursive: true });
  installProcedureRuntimeAssets(
    typiaRuntimeNodeModulesTarget,
    procedureRuntimeSourceTarget,
    procedureRuntimePackagesTarget,
  );
  copyFileSync(outfile, target);
  chmodSync(target, 0o755);

  console.log(`Built nanoboss-${buildCommit}`);
  logBuildSizeReport(sizeReport);
  console.log(`Installed nanoboss to ${target}`);
  console.log(`Installed procedure runtime packages to ${typiaRuntimeNodeModulesTarget}`);
  console.log(`Installed procedure runtime source to ${procedureRuntimeSourceTarget}`);
  console.log(`Installed procedure runtime workspace packages to ${procedureRuntimePackagesTarget}`);

  try {
    accessSync(installDir, constants.W_OK | constants.X_OK);
  } catch {
    console.warn(`Warning: ${installDir} may not be writable/executable in this environment.`);
  }
}

interface BuildSizeReport {
  binaryBytes: number;
  estimatedBundleBytes?: number;
  estimatedRuntimeBytes?: number;
  estimatedAppBytes?: number;
  estimatedDependencyBytes?: number;
  estimatedUnmappedBytes?: number;
  appGroups: Array<{ label: string; bytes: number }>;
  dependencyGroups: Array<{ label: string; bytes: number }>;
  warnings: string[];
}

function resolveBuildCommit(): string {
  try {
    const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!commit) {
      return "unknown";
    }

    const dirty = isDirtyWorkingTree() ? "-dirty" : "";
    return `${commit}${dirty}`;
  } catch {
    return "unknown";
  }
}

function isDirtyWorkingTree(): boolean {
  try {
    execFileSync("git", ["diff", "--quiet", "--ignore-submodules", "HEAD", "--"], {
      cwd: process.cwd(),
      stdio: "ignore",
    });
    return false;
  } catch {
    return true;
  }
}

function createBaseBuildConfig(commit: string): Bun.BuildConfig {
  return {
    entrypoints: ["./nanoboss.ts"],
    define: {
      "globalThis.__NANOBOSS_BUILD_COMMIT__": JSON.stringify(commit),
    },
    plugins: [
      UnpluginTypia({ log: false }),
    ],
    // unplugin-typia has an optional dynamic import of `svelte/compiler` for
    // Svelte sources. nanoboss command modules are TypeScript-only, so keep that
    // optional path external instead of forcing Bun to resolve Svelte at bundle time.
    external: ["svelte/compiler"],
  };
}

async function collectBuildSizeReport(
  commit: string,
): Promise<BuildSizeReport> {
  const binaryBytes = statSync(outfile).size;
  const analysisDir = mkdtempSync(join(tmpdir(), "nanoboss-build-analysis-"));

  try {
    const analysisResult = await Bun.build({
      ...createBaseBuildConfig(commit),
      target: "bun",
      format: "esm",
      minify: true,
      sourcemap: "external",
      outdir: analysisDir,
    });

    if (!analysisResult.success) {
      return {
        binaryBytes,
        appGroups: [],
        dependencyGroups: [],
        warnings: [`Bundle breakdown unavailable: ${summarizeBuildLogs(analysisResult.logs)}`],
      };
    }

    const bundleArtifact = analysisResult.outputs.find((artifact) => artifact.kind === "entry-point");
    const sourcemapArtifact = analysisResult.outputs.find((artifact) => artifact.kind === "sourcemap");
    if (!bundleArtifact || !sourcemapArtifact) {
      return {
        binaryBytes,
        appGroups: [],
        dependencyGroups: [],
        warnings: ["Bundle breakdown unavailable: analysis build did not emit both a bundle and sourcemap."],
      };
    }

    try {
      const [bundleText, sourceMapText] = await Promise.all([
        bundleArtifact.text(),
        sourcemapArtifact.text(),
      ]);
      const summary = summarizeBundledSources(
        attributeSourceMapBytes(bundleText, sourceMapText, sourcemapArtifact.path),
        process.cwd(),
      );
      const estimatedBundleBytes = bundleArtifact.size;
      const accountedBundleBytes = summary.appBytes + summary.dependencyBytes + summary.unmappedBytes;
      const residualBytes = estimatedBundleBytes - accountedBundleBytes;
      const estimatedUnmappedBytes = summary.unmappedBytes + Math.max(residualBytes, 0);
      const warnings = residualBytes < 0
        ? [`Bundle breakdown over-attributed the bundle by ${formatByteSize(-residualBytes)}.`]
        : [];

      return {
        binaryBytes,
        estimatedBundleBytes,
        estimatedRuntimeBytes: Math.max(binaryBytes - estimatedBundleBytes, 0),
        estimatedAppBytes: summary.appBytes,
        estimatedDependencyBytes: summary.dependencyBytes,
        estimatedUnmappedBytes,
        appGroups: summary.appGroups,
        dependencyGroups: summary.dependencyGroups,
        warnings,
      };
    } catch (error) {
      return {
        binaryBytes,
        appGroups: [],
        dependencyGroups: [],
        warnings: [
          `Bundle breakdown unavailable: ${error instanceof Error ? error.message : String(error)}`,
        ],
      };
    }
  } finally {
    rmSync(analysisDir, { recursive: true, force: true });
  }
}

function logBuildSizeReport(report: BuildSizeReport): void {
  console.log(`Binary size: ${formatByteSize(report.binaryBytes)}`);

  if (report.estimatedBundleBytes !== undefined) {
    console.log(
      `Estimated embedded bundle: ${formatByteSize(report.estimatedBundleBytes)} ` +
      "(derived from a matching minified Bun bundle)",
    );
  }
  if (report.estimatedRuntimeBytes !== undefined) {
    console.log(`Estimated Bun runtime/loader: ${formatByteSize(report.estimatedRuntimeBytes)}`);
  }
  if (report.estimatedAppBytes !== undefined) {
    console.log(`Estimated bundled app code: ${formatByteSize(report.estimatedAppBytes)}`);
  }
  if (report.estimatedDependencyBytes !== undefined) {
    console.log(`Estimated bundled dependencies: ${formatByteSize(report.estimatedDependencyBytes)}`);
  }
  if (report.estimatedUnmappedBytes !== undefined && report.estimatedUnmappedBytes > 0) {
    console.log(`Estimated bundler helpers/unmapped: ${formatByteSize(report.estimatedUnmappedBytes)}`);
  }
  if (report.appGroups.length > 0) {
    console.log("Top bundled app areas:");
    for (const group of report.appGroups) {
      console.log(`  - ${group.label}: ${formatByteSize(group.bytes)}`);
    }
  }
  if (report.dependencyGroups.length > 0) {
    console.log("Top bundled dependencies:");
    for (const group of report.dependencyGroups) {
      console.log(`  - ${group.label}: ${formatByteSize(group.bytes)}`);
    }
  }
  if (report.estimatedBundleBytes !== undefined) {
    console.log("Bundle/runtime figures are estimates because Bun does not expose a compiled-binary breakdown here.");
  }
  for (const warning of report.warnings) {
    console.warn(`Build size note: ${warning}`);
  }
}

function summarizeBuildLogs(logs: Bun.BuildOutput["logs"]): string {
  const messages = logs
    .slice(0, 3)
    .map((log) => {
      if (typeof log.message === "string" && log.message.length > 0) {
        return log.message;
      }
      return JSON.stringify(log);
    })
    .filter((message) => message.length > 0);
  if (messages.length === 0) {
    return "unknown build error";
  }
  return messages.join(" | ");
}

function installProcedureRuntimeAssets(
  targetNodeModulesDir: string,
  targetSourceDir: string,
  targetPackagesDir: string,
): void {
  rmSync(targetNodeModulesDir, { recursive: true, force: true });
  mkdirSync(targetNodeModulesDir, { recursive: true });
  rmSync(targetSourceDir, { recursive: true, force: true });
  cpSync(join(process.cwd(), "src"), targetSourceDir, { recursive: true });
  rmSync(targetPackagesDir, { recursive: true, force: true });
  cpSync(join(process.cwd(), "packages"), targetPackagesDir, { recursive: true });

  const copiedPackages = new Set<string>();
  installWorkspaceRuntimePackages(targetNodeModulesDir, targetPackagesDir, copiedPackages);
  copyPackageClosure("typia", targetNodeModulesDir, copiedPackages);
}

function installWorkspaceRuntimePackages(
  targetNodeModulesDir: string,
  targetPackagesDir: string,
  copiedPackages: Set<string>,
): void {
  for (const entry of readdirSync(targetPackagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const packageDir = entry.name;
    const packageJsonPath = join(targetPackagesDir, packageDir, "package.json");
    try {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
        name?: string;
        dependencies?: Record<string, string>;
        optionalDependencies?: Record<string, string>;
      };
      const packageName = packageJson.name?.trim();
      if (!packageName) {
        continue;
      }

      const targetPackageDir = join(targetNodeModulesDir, ...packageName.split("/"));
      mkdirSync(dirname(targetPackageDir), { recursive: true });
      symlinkRuntimePackage(join(targetPackagesDir, packageDir), targetPackageDir);

      for (const dependencyName of Object.keys({
        ...packageJson.dependencies,
        ...packageJson.optionalDependencies,
      })) {
        if (dependencyName.startsWith("@nanoboss/")) {
          continue;
        }
        copyPackageClosure(dependencyName, targetNodeModulesDir, copiedPackages);
      }
    } catch {
      continue;
    }
  }
}

function symlinkRuntimePackage(sourceDir: string, targetDir: string): void {
  rmSync(targetDir, { recursive: true, force: true });
  symlinkSync(sourceDir, targetDir, "dir");
}

function copyPackageClosure(
  packageName: string,
  targetNodeModulesDir: string,
  copiedPackages: Set<string>,
): void {
  if (copiedPackages.has(packageName)) {
    return;
  }
  copiedPackages.add(packageName);

  const sourcePackageDir = resolveInstalledPackageDir(packageName);
  const targetPackageDir = join(targetNodeModulesDir, ...packageName.split("/"));
  mkdirSync(dirname(targetPackageDir), { recursive: true });
  cpSync(sourcePackageDir, targetPackageDir, { recursive: true });

  const packageJsonPath = join(sourcePackageDir, "package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };

  for (const dependencyName of Object.keys({
    ...packageJson.dependencies,
    ...packageJson.optionalDependencies,
  })) {
    copyPackageClosure(dependencyName, targetNodeModulesDir, copiedPackages);
  }
}

function resolveInstalledPackageDir(packageName: string): string {
  const packagePathSegments = packageName.split("/");
  const candidatePaths = [
    join(process.cwd(), "node_modules", ...packagePathSegments),
    join(process.cwd(), "node_modules", ".bun", "node_modules", ...packagePathSegments),
  ];

  for (const candidatePath of candidatePaths) {
    if (existsSync(candidatePath)) {
      return realpathSync(candidatePath);
    }
  }

  throw new Error(`Unable to locate installed package directory for ${packageName}`);
}
