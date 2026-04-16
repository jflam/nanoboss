import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  extractFailureDetails,
  mergeCompactTestReports,
  parseJunitReport,
  renderCompactTestOutput,
} from "../src/util/compact-test.ts";
import {
  createCompactTestCacheKey,
  findPassingCompactTestCacheEntry,
  getCompactTestCachePath,
  loadCompactTestCache,
  normalizeCompactTestCommand,
  normalizeSelectedTests,
  upsertCompactTestCacheEntry,
  writeCompactTestCache,
} from "../procedures/nanoboss/compact-test-cache.ts";

interface CompactTestRunResult {
  rawOutput: string;
  report?: ReturnType<typeof parseJunitReport>;
  exitCode: number;
}

interface CompactTestRunPlanEntry {
  label: string;
  args: string[];
}

const STREAM_PROGRESS_ENV = "NANOBOSS_STREAM_TEST_PROGRESS";

const UNIT_HEAVY_FILES = [
  "tests/unit/default-memory-bridge.test.ts",
  "tests/unit/mcp-server.test.ts",
  "tests/unit/service.test.ts",
] as const;

const UNIT_ENV_FILES = [
  "tests/unit/config.test.ts",
  "tests/unit/current-session.test.ts",
  "tests/unit/default-history.test.ts",
  "tests/unit/mcp-registration.test.ts",
  "tests/unit/mcp-stdio.test.ts",
  "tests/unit/procedure-dispatch-jobs.test.ts",
  "tests/unit/resume.test.ts",
  "tests/unit/second-opinion-inherits-default-model.test.ts",
  "tests/unit/stored-sessions.test.ts",
  "tests/unit/test-home-isolation.test.ts",
] as const;

const args = Bun.argv.slice(2);
const plan = resolveOptimizedPlan(args);

if (!plan) {
  const result = await runBunTest(args);
  writeResult(result);
} else {
  const startedAt = performance.now();
  const results = await Promise.all(plan.map((entry) => runBunTest(entry.args)));
  const elapsedSeconds = (performance.now() - startedAt) / 1_000;

  if (results.some((result) => !result.report)) {
    process.stdout.write(results.map((result) => result.rawOutput).filter(Boolean).join("\n"));
    process.exitCode = results.find((result) => result.exitCode !== 0)?.exitCode ?? 1;
  } else {
    const report = mergeCompactTestReports(
      results.flatMap((result) => result.report ? [result.report] : []),
      elapsedSeconds,
    );
    const failureDetails = results
      .map((result) => extractFailureDetails(result.rawOutput))
      .filter(Boolean)
      .join("\n\n");
    process.stdout.write(renderCompactTestOutput(report, failureDetails));
    process.exitCode = results.find((result) => result.exitCode !== 0)?.exitCode ?? 0;
  }
}

function resolveOptimizedPlan(args: string[]): CompactTestRunPlanEntry[] | undefined {
  if (args.some((arg) => arg.startsWith("-"))) {
    return undefined;
  }

  const normalizedArgs = args.map(normalizeTestArg);
  if (normalizedArgs.length === 0) {
    return buildUnitPlan();
  }

  if (normalizedArgs.length === 1 && normalizedArgs[0] === "tests/unit") {
    return buildUnitPlan();
  }

  return undefined;
}

function buildUnitPlan(): CompactTestRunPlanEntry[] {
  const unitDir = join(process.cwd(), "tests", "unit");
  const allUnitFiles = readdirSync(unitDir)
    .filter((name) => name.endsWith(".test.ts"))
    .map((name) => `tests/unit/${name}`)
    .sort();

  const heavyFiles = UNIT_HEAVY_FILES.filter((path) => allUnitFiles.includes(path));
  const envFiles = UNIT_ENV_FILES.filter((path) => allUnitFiles.includes(path));
  const isolatedFiles = new Set<string>([...heavyFiles, ...envFiles]);
  const parallelFiles = allUnitFiles.filter((path) => !isolatedFiles.has(path));

  return [
    {
      label: "unit-parallel",
      args: parallelFiles,
    },
    {
      label: "unit-env",
      args: envFiles,
    },
    {
      label: "unit-heavy",
      args: heavyFiles,
    },
  ].filter((entry) => entry.args.length > 0);
}

function normalizeTestArg(arg: string): string {
  return arg.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function writeResult(result: CompactTestRunResult): void {
  const failureDetails = extractFailureDetails(result.rawOutput);
  if (!result.report) {
    process.stdout.write(result.rawOutput);
    process.exitCode = result.exitCode;
    return;
  }

  process.stdout.write(renderCompactTestOutput(result.report, failureDetails));
  process.exitCode = result.exitCode;
}

async function runBunTest(args: string[]): Promise<CompactTestRunResult> {
  const selectedTests = normalizeSelectedTests(args);
  const cachePath = getCompactTestCachePath(process.cwd());
  const cacheKey = createCompactTestCacheKey(process.cwd(), selectedTests);
  const cached = findPassingCompactTestCacheEntry(loadCompactTestCache(cachePath), cacheKey);
  if (cached) {
    const command = cached.command || normalizeCompactTestCommand(selectedTests);
    return {
      rawOutput: `test-clean cache hit: ${command} for repo ${cacheKey.repoFingerprint}\n`,
      report: cached.report,
      exitCode: 0,
    };
  }

  const tempDir = mkdtempSync(join(tmpdir(), "nanoboss-compact-test-"));
  const junitPath = join(tempDir, "report.xml");
  const streamProgress = process.env[STREAM_PROGRESS_ENV] === "1";
  const child = spawn("bun", [
    "test",
    "--only-failures",
    "--reporter=junit",
    "--reporter-outfile",
    junitPath,
    ...args,
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NO_COLOR: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    if (streamProgress) {
      process.stdout.write(chunk);
    }
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
    if (streamProgress) {
      process.stderr.write(chunk);
    }
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      resolve(code ?? 1);
    });
  });

  try {
    const rawOutput = [stdout, stderr].filter(Boolean).join("\n");
    const xml = existsSync(junitPath) ? readFileSync(junitPath, "utf8") : "";
    const report = xml ? parseJunitReport(xml) : undefined;
    if (exitCode === 0) {
      const cache = loadCompactTestCache(cachePath);
      writeCompactTestCache(cachePath, upsertCompactTestCacheEntry(cache, {
        repoFingerprint: cacheKey.repoFingerprint,
        commandFingerprint: cacheKey.commandFingerprint,
        runtimeFingerprint: cacheKey.runtimeFingerprint,
        command: normalizeCompactTestCommand(selectedTests),
        selectedTests,
        status: "passed",
        passedAt: new Date().toISOString(),
        durationMs: Math.round((report?.timeSeconds ?? 0) * 1000),
        summary: report
          ? `${report.passed} pass, ${report.skipped} skip, ${report.failed} fail, ${report.total} total`
          : undefined,
        report,
      }));
    }
    return { rawOutput, report, exitCode };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
