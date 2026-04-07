import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { formatErrorMessage } from "../core/error-format.ts";

import type {
  AutoresearchBenchmarkConfig,
  AutoresearchBenchmarkResult,
  AutoresearchCheckConfig,
  AutoresearchCheckResult,
  AutoresearchCommandSpec,
  AutoresearchMetricConfig,
} from "./types.ts";

interface CommandRunResult {
  command: string;
  cwd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

const DEFAULT_MAX_BUFFER_BYTES = 10 * 1024 * 1024;

export function runBenchmark(config: AutoresearchBenchmarkConfig, repoRoot: string): AutoresearchBenchmarkResult {
  const sampleCount = Math.max(1, Math.floor(config.samples ?? 1));
  const samples: number[] = [];
  let lastRun: CommandRunResult | undefined;
  let totalDurationMs = 0;
  let timedOut = false;

  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    const run = runCommandSpec(config, repoRoot, "benchmark command");
    lastRun = run;
    totalDurationMs += run.durationMs;
    timedOut = timedOut || run.timedOut;

    const metric = extractMetric(run, config.metric);
    if (metric !== undefined) {
      samples.push(metric);
    }
  }

  if (!lastRun) {
    throw new Error("Benchmark command did not execute");
  }

  return {
    command: lastRun.command,
    cwd: lastRun.cwd,
    exitCode: lastRun.exitCode,
    stdout: lastRun.stdout,
    stderr: lastRun.stderr,
    durationMs: totalDurationMs,
    timedOut,
    samples,
    metric: samples.length > 0 ? average(samples) : undefined,
  };
}

export function runChecks(configs: AutoresearchCheckConfig[], repoRoot: string): AutoresearchCheckResult[] {
  return configs.map((config) => {
    const run = runCommandSpec(config, repoRoot, `check command ${config.name}`);
    const allowedExitCodes = new Set(config.allowExitCodes ?? [0]);
    return {
      name: config.name,
      command: run.command,
      cwd: run.cwd,
      exitCode: run.exitCode,
      stdout: run.stdout,
      stderr: run.stderr,
      durationMs: run.durationMs,
      timedOut: run.timedOut,
      passed: allowedExitCodes.has(run.exitCode),
    };
  });
}

export function renderCommand(argv: string[]): string {
  return argv
    .map((part) => /[\s"]/u.test(part) ? JSON.stringify(part) : part)
    .join(" ");
}

function runCommandSpec(
  spec: AutoresearchCommandSpec,
  repoRoot: string,
  description: string,
): CommandRunResult {
  if (spec.argv.length === 0) {
    throw new Error(`${description} requires a non-empty argv`);
  }

  const cwd = spec.cwd ? resolve(repoRoot, spec.cwd) : repoRoot;
  const startedAt = Date.now();
  const result = spawnSync(spec.argv[0], spec.argv.slice(1), {
    cwd,
    env: {
      ...process.env,
      ...spec.env,
    },
    encoding: "utf8",
    timeout: spec.timeoutMs,
    maxBuffer: DEFAULT_MAX_BUFFER_BYTES,
  });
  const durationMs = Date.now() - startedAt;
  const timedOut = result.error instanceof Error && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT";

  if (result.error && !timedOut) {
    throw new Error(
      `Failed to start ${description} \`${renderCommand(spec.argv)}\`: ${formatErrorMessage(result.error)}`,
      { cause: result.error },
    );
  }

  return {
    command: renderCommand(spec.argv),
    cwd,
    exitCode: typeof result.status === "number" ? result.status : timedOut ? 124 : 1,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs,
    timedOut,
  };
}

function extractMetric(run: CommandRunResult, config: AutoresearchMetricConfig): number | undefined {
  switch (config.source) {
    case "exit-code":
      return run.exitCode;
    case "stdout-regex":
      if (run.exitCode !== 0) {
        return undefined;
      }
      return parseRegexMetric(run.stdout, config);
    case "stderr-regex":
      if (run.exitCode !== 0) {
        return undefined;
      }
      return parseRegexMetric(run.stderr, config);
    case "json-path":
      if (run.exitCode !== 0) {
        return undefined;
      }
      return parseJsonMetric(config.jsonStream === "stderr" ? run.stderr : run.stdout, config);
  }
}

function parseRegexMetric(text: string, config: AutoresearchMetricConfig): number {
  if (!config.pattern) {
    throw new Error(`Metric ${config.name} requires a regex pattern`);
  }

  const match = new RegExp(config.pattern, config.flags).exec(text);
  if (!match) {
    throw new Error(`Metric ${config.name} could not be extracted with regex ${config.pattern}`);
  }

  const captureIndex = config.captureGroup ?? (match.length > 1 ? 1 : 0);
  const rawValue = match[captureIndex];
  const parsed = Number.parseFloat(rawValue);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Metric ${config.name} did not resolve to a finite number: ${rawValue}`);
  }

  return parsed;
}

function parseJsonMetric(text: string, config: AutoresearchMetricConfig): number {
  if (!config.path) {
    throw new Error(`Metric ${config.name} requires a JSON path`);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(text);
  } catch (error) {
    throw new Error(`Metric ${config.name} expected JSON output: ${formatErrorMessage(error)}`, {
      cause: error,
    });
  }

  const resolved = readJsonPath(parsedJson, config.path);
  if (typeof resolved !== "number" || !Number.isFinite(resolved)) {
    throw new Error(`Metric ${config.name} at ${config.path} was not a finite number`);
  }

  return resolved;
}

function readJsonPath(value: unknown, path: string): unknown {
  const segments = path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter(Boolean);

  let current = value;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      const index = Number.parseInt(segment, 10);
      current = current[index];
      continue;
    }

    if (!current || typeof current !== "object") {
      return undefined;
    }

    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
