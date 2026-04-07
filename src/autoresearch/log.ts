import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";

import type {
  AutoresearchConfidenceSummary,
  AutoresearchExperimentRecord,
  AutoresearchPaths,
} from "./types.ts";

export function appendExperimentRecord(paths: AutoresearchPaths, record: AutoresearchExperimentRecord): void {
  mkdirSync(paths.storageDir, { recursive: true });
  appendFileSync(paths.logPath, `${JSON.stringify(record)}\n`, "utf8");
}

export function readExperimentLog(paths: AutoresearchPaths): AutoresearchExperimentRecord[] {
  if (!existsSync(paths.logPath)) {
    return [];
  }

  return readFileSync(paths.logPath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as AutoresearchExperimentRecord);
}

export function computeConfidenceSummary(
  existingRecords: AutoresearchExperimentRecord[],
  nextMetric?: number,
): AutoresearchConfidenceSummary | undefined {
  const metrics = existingRecords
    .map((record) => record.benchmark.metric)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));

  if (typeof nextMetric === "number" && Number.isFinite(nextMetric)) {
    metrics.push(nextMetric);
  }

  if (metrics.length === 0) {
    return undefined;
  }

  const mean = metrics.reduce((sum, value) => sum + value, 0) / metrics.length;
  const variance = metrics.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / metrics.length;

  return {
    sampleCount: metrics.length,
    mean,
    min: Math.min(...metrics),
    max: Math.max(...metrics),
    stddev: Math.sqrt(variance),
    latest: metrics[metrics.length - 1],
  };
}
