import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DownstreamAgentProvider } from "@nanoboss/contracts";

import { getNanobossHome } from "./config.ts";
import type { AgentCatalogEntry } from "./model-catalog.ts";
import type { DownstreamAgentConfig } from "./types.ts";

const AGENT_CATALOG_DISCOVERY_CACHE_TTL_MS = 5_000;
const AGENT_CATALOG_DISCOVERY_CACHE_DIR = "agent-catalogs";
const AGENT_CATALOG_DISCOVERY_CACHE_VERSION = 1;

interface CachedAgentCatalogValue {
  kind: "value";
  catalog: AgentCatalogEntry;
  expiresAt: number;
  refreshedAtMs: number;
}

interface CachedAgentCatalogPromise {
  kind: "promise";
  promise: Promise<AgentCatalogEntry>;
  fallback?: CachedAgentCatalogValue;
}

type CachedAgentCatalogEntry = CachedAgentCatalogValue | CachedAgentCatalogPromise;

const discoveredAgentCatalogCache = new Map<string, CachedAgentCatalogEntry>();

interface PersistedAgentCatalogRecord {
  version: number;
  updatedAt: string;
  catalog: AgentCatalogEntry;
}

export function createAgentCatalogDiscoveryCacheKey(
  provider: DownstreamAgentProvider,
  config: DownstreamAgentConfig,
): string {
  return JSON.stringify({
    provider,
    command: config.command,
    args: config.args,
    cwd: config.cwd ?? null,
    envShape: describeAgentCatalogDiscoveryEnvShape(config.env),
  });
}

export function hasCachedAgentCatalogRefreshedToday(
  cacheKey: string,
  now: number,
): boolean {
  const cached = discoveredAgentCatalogCache.get(cacheKey);
  if (cached?.kind === "value" && isTimestampToday(cached.refreshedAtMs, now)) {
    return true;
  }
  if (cached?.kind === "promise" && cached.fallback && isTimestampToday(cached.fallback.refreshedAtMs, now)) {
    return true;
  }

  return getPersistedAgentCatalogValue(cacheKey, now, true) !== undefined;
}

export function getCachedAgentCatalog(
  cacheKey: string,
  now: number,
): AgentCatalogEntry | Promise<AgentCatalogEntry> | undefined {
  const entry = discoveredAgentCatalogCache.get(cacheKey);
  if (!entry) {
    return undefined;
  }

  if (entry.kind === "promise") {
    return entry.promise;
  }

  if (entry.expiresAt > now) {
    return entry.catalog;
  }

  discoveredAgentCatalogCache.delete(cacheKey);
  return undefined;
}

export function getCachedAgentCatalogValue(
  cacheKey: string,
  now: number,
): CachedAgentCatalogValue | undefined {
  const entry = discoveredAgentCatalogCache.get(cacheKey);
  if (!entry || entry.kind !== "value") {
    return undefined;
  }

  if (entry.expiresAt > now) {
    return entry;
  }

  discoveredAgentCatalogCache.delete(cacheKey);
  return undefined;
}

export function setCachedAgentCatalogValue(
  cacheKey: string,
  value: CachedAgentCatalogValue,
): void {
  discoveredAgentCatalogCache.set(cacheKey, value);
}

export function storePendingAgentCatalogDiscovery(
  cacheKey: string,
  discovery: Promise<AgentCatalogEntry>,
  fallback: CachedAgentCatalogValue | undefined,
): Promise<AgentCatalogEntry> {
  const pendingEntry: CachedAgentCatalogPromise = {
    kind: "promise",
    promise: discovery,
    fallback,
  };

  discoveredAgentCatalogCache.set(cacheKey, pendingEntry);

  const pendingPromise = discovery.then(
    (catalog) => {
      const current = discoveredAgentCatalogCache.get(cacheKey);
      if (current?.kind === "promise" && current.promise === pendingPromise) {
        const refreshedAtMs = Date.now();
        discoveredAgentCatalogCache.set(cacheKey, {
          kind: "value",
          catalog,
          expiresAt: refreshedAtMs + AGENT_CATALOG_DISCOVERY_CACHE_TTL_MS,
          refreshedAtMs,
        });
        writePersistedAgentCatalog(cacheKey, catalog, refreshedAtMs);
      }
      return catalog;
    },
    (error) => {
      const current = discoveredAgentCatalogCache.get(cacheKey);
      if (current?.kind === "promise" && current.promise === pendingPromise) {
        if (current.fallback && current.fallback.expiresAt > Date.now()) {
          discoveredAgentCatalogCache.set(cacheKey, current.fallback);
        } else {
          discoveredAgentCatalogCache.delete(cacheKey);
        }
      }
      throw error;
    },
  );

  pendingEntry.promise = pendingPromise;
  discoveredAgentCatalogCache.set(cacheKey, pendingEntry);
  return pendingPromise;
}

export function getPersistedAgentCatalogValue(
  cacheKey: string,
  now: number,
  requireToday: boolean,
): CachedAgentCatalogValue | undefined {
  const persisted = readPersistedAgentCatalog(cacheKey);
  if (!persisted) {
    return undefined;
  }

  const refreshedAtMs = Date.parse(persisted.updatedAt);
  if (!Number.isFinite(refreshedAtMs)) {
    return undefined;
  }
  if (requireToday && !isTimestampToday(refreshedAtMs, now)) {
    return undefined;
  }

  return {
    kind: "value",
    catalog: persisted.catalog,
    expiresAt: now + AGENT_CATALOG_DISCOVERY_CACHE_TTL_MS,
    refreshedAtMs,
  };
}

function describeAgentCatalogDiscoveryEnvShape(
  env: DownstreamAgentConfig["env"],
): Array<[name: string, state: "empty" | "set"]> | undefined {
  if (!env) {
    return undefined;
  }

  return Object.entries(env)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => [name, value.trim() ? "set" : "empty"]);
}

function readPersistedAgentCatalog(cacheKey: string): PersistedAgentCatalogRecord | undefined {
  const path = getPersistedAgentCatalogPath(cacheKey);
  if (!existsSync(path)) {
    return undefined;
  }

  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<PersistedAgentCatalogRecord>;
    if (
      raw.version !== AGENT_CATALOG_DISCOVERY_CACHE_VERSION
      || typeof raw.updatedAt !== "string"
      || !isAgentCatalogEntry(raw.catalog)
    ) {
      return undefined;
    }

    return {
      version: raw.version,
      updatedAt: raw.updatedAt,
      catalog: raw.catalog,
    };
  } catch {
    return undefined;
  }
}

function writePersistedAgentCatalog(
  cacheKey: string,
  catalog: AgentCatalogEntry,
  refreshedAtMs: number,
): void {
  const path = getPersistedAgentCatalogPath(cacheKey);
  const tempPath = `${path}.${process.pid}.tmp`;
  const record: PersistedAgentCatalogRecord = {
    version: AGENT_CATALOG_DISCOVERY_CACHE_VERSION,
    updatedAt: new Date(refreshedAtMs).toISOString(),
    catalog,
  };

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(tempPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  renameSync(tempPath, path);
}

function getPersistedAgentCatalogPath(cacheKey: string): string {
  return join(
    getNanobossHome(),
    "cache",
    AGENT_CATALOG_DISCOVERY_CACHE_DIR,
    `${createHash("sha256").update(cacheKey).digest("hex")}.json`,
  );
}

function isAgentCatalogEntry(value: unknown): value is AgentCatalogEntry {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;
  return typeof record.provider === "string"
    && typeof record.label === "string"
    && Array.isArray(record.models);
}

function isTimestampToday(timestampMs: number, nowMs: number): boolean {
  return formatLocalDateKey(timestampMs) === formatLocalDateKey(nowMs);
}

function formatLocalDateKey(timestampMs: number): string {
  const date = new Date(timestampMs);
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
