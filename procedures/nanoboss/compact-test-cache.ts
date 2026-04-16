import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { computeRepoFingerprint } from "../lib/repo-fingerprint.ts";

const TEST_CLEAN_CACHE_RELATIVE_PATH = ".nanoboss/test-clean.json";

export type CompactTestStatus = "." | "F" | "S";

export interface CompactTestReport {
  statuses: CompactTestStatus[];
  total: number;
  passed: number;
  skipped: number;
  failed: number;
  timeSeconds?: number;
}

export interface CompactTestCacheEntry {
  repoFingerprint: string;
  commandFingerprint: string;
  runtimeFingerprint: string;
  command: string;
  selectedTests: string[];
  status: "passed" | "failed";
  passedAt?: string;
  durationMs?: number;
  summary?: string;
  report?: CompactTestReport;
}

export interface CompactTestCache {
  version: 1;
  updatedAt: string;
  entries: CompactTestCacheEntry[];
}

export interface CompactTestCacheKey {
  repoFingerprint: string;
  commandFingerprint: string;
  runtimeFingerprint: string;
}

export function getCompactTestCachePath(cwd: string): string {
  return join(computeRepoFingerprint({ cwd }).repoRoot, TEST_CLEAN_CACHE_RELATIVE_PATH);
}

export function computeCompactTestCommandFingerprint(args: string[]): string {
  return sha256(normalizeCompactTestCommand(args));
}

export function normalizeCompactTestCommand(args: string[]): string {
  return ["bun", "test", "--only-failures", ...normalizeSelectedTests(args)].join(" ");
}

export function computeCompactTestRuntimeFingerprint(
  input: {
    bunVersion?: string;
    platform?: NodeJS.Platform;
    arch?: string;
  } = {},
): string {
  return sha256([
    input.bunVersion ?? Bun.version,
    input.platform ?? process.platform,
    input.arch ?? process.arch,
  ].join("\u0000"));
}

export function createCompactTestCacheKey(cwd: string, args: string[]): CompactTestCacheKey {
  return {
    repoFingerprint: computeRepoFingerprint({ cwd }).fingerprint,
    commandFingerprint: computeCompactTestCommandFingerprint(args),
    runtimeFingerprint: computeCompactTestRuntimeFingerprint(),
  };
}

export function loadCompactTestCache(cachePath: string): CompactTestCache {
  if (!existsSync(cachePath)) {
    return createEmptyCompactTestCache();
  }

  try {
    const raw = JSON.parse(readFileSync(cachePath, "utf8")) as unknown;
    return isCompactTestCache(raw) ? raw : createEmptyCompactTestCache();
  } catch {
    return createEmptyCompactTestCache();
  }
}

export function findPassingCompactTestCacheEntry(
  cache: CompactTestCache,
  key: CompactTestCacheKey,
): CompactTestCacheEntry | undefined {
  return cache.entries.find((entry) =>
    entry.status === "passed"
    && entry.repoFingerprint === key.repoFingerprint
    && entry.commandFingerprint === key.commandFingerprint
    && entry.runtimeFingerprint === key.runtimeFingerprint);
}

export function upsertCompactTestCacheEntry(
  cache: CompactTestCache,
  entry: CompactTestCacheEntry,
): CompactTestCache {
  const retained = cache.entries.filter((candidate) =>
    candidate.repoFingerprint !== entry.repoFingerprint
    || candidate.commandFingerprint !== entry.commandFingerprint
    || candidate.runtimeFingerprint !== entry.runtimeFingerprint);
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    entries: [...retained, entry].slice(-200),
  };
}

export function writeCompactTestCache(cachePath: string, cache: CompactTestCache): void {
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
}

export function normalizeSelectedTests(args: string[]): string[] {
  return [...new Set(args.map((value) => value.trim()).filter((value) => value.length > 0))]
    .map((value) => value.replaceAll("\\", "/").replace(/^\.\//u, ""))
    .sort((left, right) => left.localeCompare(right));
}

function createEmptyCompactTestCache(): CompactTestCache {
  return {
    version: 1,
    updatedAt: new Date(0).toISOString(),
    entries: [],
  };
}

function isCompactTestCache(value: unknown): value is CompactTestCache {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return candidate.version === 1
    && typeof candidate.updatedAt === "string"
    && Array.isArray(candidate.entries)
    && candidate.entries.every(isCompactTestCacheEntry);
}

function isCompactTestCacheEntry(value: unknown): value is CompactTestCacheEntry {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return typeof candidate.repoFingerprint === "string"
    && typeof candidate.commandFingerprint === "string"
    && typeof candidate.runtimeFingerprint === "string"
    && typeof candidate.command === "string"
    && Array.isArray(candidate.selectedTests)
    && candidate.selectedTests.every((item) => typeof item === "string")
    && (candidate.status === "passed" || candidate.status === "failed")
    && (candidate.passedAt === undefined || typeof candidate.passedAt === "string")
    && (candidate.durationMs === undefined || typeof candidate.durationMs === "number")
    && (candidate.summary === undefined || typeof candidate.summary === "string")
    && (candidate.report === undefined || isCompactTestReport(candidate.report));
}

function isCompactTestReport(value: unknown): value is CompactTestReport {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return Array.isArray(candidate.statuses)
    && candidate.statuses.every((item) => item === "." || item === "F" || item === "S")
    && typeof candidate.total === "number"
    && typeof candidate.passed === "number"
    && typeof candidate.skipped === "number"
    && typeof candidate.failed === "number"
    && (candidate.timeSeconds === undefined || typeof candidate.timeSeconds === "number");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}
