import type * as acp from "@agentclientprotocol/sdk";
import type { DownstreamAgentProvider } from "@nanoboss/contracts";

import { resolveSelectedDownstreamAgentConfig } from "./config.ts";
import {
  getProviderLabel,
  getAgentCatalog,
  type AgentCatalogEntry,
  type CatalogModelEntry,
  isReasoningEffort,
  REASONING_EFFORTS,
  type ReasoningEffort,
  parseReasoningModelSelection,
} from "./model-catalog.ts";
import { buildAgentRuntimeSessionRuntime } from "./runtime-capability.ts";
import { closeAcpConnection, openAcpConnection } from "./runtime.ts";
import type { DownstreamAgentConfig } from "./types.ts";

export interface DiscoverAgentCatalogOptions {
  config?: Partial<Pick<DownstreamAgentConfig, "args" | "command" | "cwd" | "env">>;
  forceRefresh?: boolean;
}

const AGENT_CATALOG_DISCOVERY_CACHE_TTL_MS = 5_000;

interface CachedAgentCatalogValue {
  kind: "value";
  catalog: AgentCatalogEntry;
  expiresAt: number;
}

interface CachedAgentCatalogPromise {
  kind: "promise";
  promise: Promise<AgentCatalogEntry>;
  fallback?: CachedAgentCatalogValue;
}

type CachedAgentCatalogEntry = CachedAgentCatalogValue | CachedAgentCatalogPromise;

const discoveredAgentCatalogCache = new Map<string, CachedAgentCatalogEntry>();

export async function discoverAgentCatalog(
  provider: DownstreamAgentProvider,
  options: DiscoverAgentCatalogOptions = {},
): Promise<AgentCatalogEntry> {
  const now = Date.now();
  const config = resolveAgentCatalogDiscoveryConfig(provider, options);
  const cacheKey = createAgentCatalogDiscoveryCacheKey(provider, config);

  if (!options.forceRefresh) {
    const cached = getCachedAgentCatalog(cacheKey, now);
    if (cached) {
      return cached;
    }
  }

  const fallback = getCachedAgentCatalogValue(cacheKey, now);
  const discovery = discoverAgentCatalogUncached(provider, config);

  return storePendingAgentCatalogDiscovery(cacheKey, discovery, fallback);
}

async function discoverAgentCatalogUncached(
  provider: DownstreamAgentProvider,
  config: DownstreamAgentConfig,
): Promise<AgentCatalogEntry> {
  const state = await openAcpConnection(config);
  let sessionId: acp.SessionId | undefined;
  let catalog: AgentCatalogEntry | undefined;
  let discoveryError: unknown;

  try {
    const session = await state.connection.newSession({
      cwd: state.cwd,
      ...buildAgentRuntimeSessionRuntime(),
    });
    sessionId = session.sessionId;
    catalog = await normalizeDiscoveredAgentCatalog(provider, state.connection, session);
  } catch (error) {
    discoveryError = error;
  }

  const cleanupError = await closeDiscoveryProbe(state, sessionId);

  if (discoveryError !== undefined) {
    if (cleanupError !== undefined) {
      throw new AggregateError(
        [discoveryError, cleanupError],
        "Agent catalog discovery failed and cleanup also failed.",
      );
    }
    throw discoveryError;
  }

  if (cleanupError !== undefined) {
    throw cleanupError;
  }

  if (!catalog) {
    throw new Error(`Agent catalog discovery for ${provider} did not return a catalog.`);
  }

  return catalog;
}

function createAgentCatalogDiscoveryCacheKey(
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

function getCachedAgentCatalog(
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

function getCachedAgentCatalogValue(
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

function storePendingAgentCatalogDiscovery(
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
        discoveredAgentCatalogCache.set(cacheKey, {
          kind: "value",
          catalog,
          expiresAt: Date.now() + AGENT_CATALOG_DISCOVERY_CACHE_TTL_MS,
        });
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

function resolveAgentCatalogDiscoveryConfig(
  provider: DownstreamAgentProvider,
  options: DiscoverAgentCatalogOptions,
): DownstreamAgentConfig {
  const override = options.config;
  const resolved = resolveSelectedDownstreamAgentConfig(
    { provider },
    override?.cwd,
  );

  return {
    ...resolved,
    command: override?.command ?? resolved.command,
    args: override?.args ?? resolved.args,
    cwd: override?.cwd ?? resolved.cwd,
    env: override?.env ? { ...resolved.env, ...override.env } : resolved.env,
  };
}

async function closeDiscoveryProbe(
  state: Awaited<ReturnType<typeof openAcpConnection>>,
  sessionId: acp.SessionId | undefined,
): Promise<unknown> {
  try {
    if (sessionId && state.capabilities?.sessionCapabilities?.close) {
      await state.connection.unstable_closeSession({ sessionId });
    }
    return undefined;
  } catch (error) {
    return error;
  } finally {
    closeAcpConnection(state);
  }
}

async function normalizeDiscoveredAgentCatalog(
  provider: DownstreamAgentProvider,
  connection: acp.ClientSideConnection,
  session: Pick<acp.NewSessionResponse, "configOptions" | "models" | "sessionId">,
): Promise<AgentCatalogEntry> {
  switch (provider) {
    case "copilot":
      return normalizeCopilotDiscoveredCatalog(provider, connection, session);
    case "codex":
      return normalizeCodexDiscoveredCatalog(provider, session);
    case "claude":
    case "gemini":
      return normalizePassThroughDiscoveredCatalog(provider, session);
  }
}

async function normalizeCopilotDiscoveredCatalog(
  provider: DownstreamAgentProvider,
  connection: acp.ClientSideConnection,
  session: Pick<acp.NewSessionResponse, "configOptions" | "models" | "sessionId">,
): Promise<AgentCatalogEntry> {
  const modelEntries = new Map<string, CatalogModelEntry>();
  const modelConfig = findModelConfigOption(session.configOptions ?? []);
  const configModels = getConfigModelCandidates(modelConfig);

  for (const model of getAvailableModelCandidates(session)) {
    mergeCatalogModel(modelEntries, model);
  }

  for (const model of configModels) {
    mergeCatalogModel(modelEntries, model);
  }

  if (modelConfig) {
    for (const model of modelEntries.values()) {
      const response = await connection.setSessionConfigOption({
        sessionId: session.sessionId,
        configId: modelConfig.id,
        value: model.id,
      });
      mergeCatalogModel(modelEntries, {
        id: model.id,
        ...extractReasoningMetadata(response.configOptions),
      });
    }
  }

  return finalizeDiscoveredAgentCatalog(provider, [...modelEntries.values()]);
}

function normalizeCodexDiscoveredCatalog(
  provider: DownstreamAgentProvider,
  session: Pick<acp.NewSessionResponse, "configOptions" | "models" | "sessionId">,
): AgentCatalogEntry {
  const collapsedEntries = new Map<string, CatalogModelEntry>();
  const modelConfig = findModelConfigOption(session.configOptions ?? []);

  for (const model of [
    ...getAvailableModelCandidates(session),
    ...getConfigModelCandidates(modelConfig),
  ]) {
    const { baseModel, reasoningEffort } = parseReasoningModelSelection(model.id);
    const id = baseModel ?? model.id;
    mergeCatalogModel(collapsedEntries, {
      id,
      name: reasoningEffort ? undefined : model.name,
      description: reasoningEffort ? undefined : model.description,
      supportedReasoningEfforts: reasoningEffort ? [reasoningEffort] : undefined,
    });
  }

  return finalizeDiscoveredAgentCatalog(provider, [...collapsedEntries.values()], {
    allowStaticReasoningDefault: true,
  });
}

function normalizePassThroughDiscoveredCatalog(
  provider: DownstreamAgentProvider,
  session: Pick<acp.NewSessionResponse, "configOptions" | "models" | "sessionId">,
): AgentCatalogEntry {
  const availableModels = getAvailableModelCandidates(session);
  const models = availableModels.length > 0
    ? availableModels
    : getConfigModelCandidates(findModelConfigOption(session.configOptions ?? []));

  return finalizeDiscoveredAgentCatalog(provider, models);
}

function finalizeDiscoveredAgentCatalog(
  provider: DownstreamAgentProvider,
  models: CatalogModelEntry[],
  options: {
    allowStaticReasoningDefault?: boolean;
  } = {},
): AgentCatalogEntry {
  return {
    provider,
    label: getProviderLabel(provider),
    models: models.map((model) => finalizeCatalogModel(provider, model, options)),
  };
}

function findModelConfigOption(
  configOptions: acp.SessionConfigOption[],
): Extract<acp.SessionConfigOption, { type: "select" }> | undefined {
  return configOptions.find(isModelConfigOption);
}

function flattenModelConfigOptions(
  modelConfig: Extract<acp.SessionConfigOption, { type: "select" }> | undefined,
): acp.SessionConfigSelectOption[] {
  if (!modelConfig) {
    return [];
  }

  return modelConfig.options.flatMap((entry) => isSessionConfigSelectOption(entry) ? [entry] : entry.options);
}

function getAvailableModelCandidates(
  session: Pick<acp.NewSessionResponse, "models">,
): CatalogModelEntry[] {
  return (session.models?.availableModels ?? []).map((model) => ({
    id: model.modelId,
    name: normalizeOptionalLabel(model.name, model.modelId),
    description: normalizeOptionalText(model.description),
  }));
}

function getConfigModelCandidates(
  modelConfig: Extract<acp.SessionConfigOption, { type: "select" }> | undefined,
): CatalogModelEntry[] {
  return flattenModelConfigOptions(modelConfig).map((model) => ({
    id: model.value,
    name: normalizeOptionalLabel(model.name, model.value),
    description: normalizeOptionalText(model.description),
  }));
}

function isSessionConfigSelectOption(
  entry: acp.SessionConfigSelectOption | acp.SessionConfigSelectGroup,
): entry is acp.SessionConfigSelectOption {
  return "value" in entry;
}

function isModelConfigOption(
  option: acp.SessionConfigOption,
): option is Extract<acp.SessionConfigOption, { type: "select" }> {
  return option.type === "select" && (option.category === "model" || option.id === "model");
}

function isReasoningConfigOption(
  option: acp.SessionConfigOption,
): option is Extract<acp.SessionConfigOption, { type: "select" }> {
  return option.type === "select"
    && (option.category === "thought_level" || option.id === "reasoning_effort");
}

function extractReasoningMetadata(
  configOptions: acp.SessionConfigOption[],
): Pick<CatalogModelEntry, "defaultReasoningEffort" | "supportedReasoningEfforts"> {
  const reasoningConfig = configOptions.find(isReasoningConfigOption);
  if (!reasoningConfig) {
    return {};
  }

  const supportedReasoningEfforts = normalizeReasoningEfforts(
    flattenModelConfigOptions(reasoningConfig).map((option) => option.value),
  );
  const defaultReasoningEffort = isReasoningEffort(reasoningConfig.currentValue)
    ? reasoningConfig.currentValue
    : undefined;

  return {
    supportedReasoningEfforts,
    defaultReasoningEffort,
  };
}

function mergeCatalogModel(
  models: Map<string, CatalogModelEntry>,
  candidate: CatalogModelEntry,
): void {
  const existing = models.get(candidate.id);
  if (!existing) {
    models.set(candidate.id, candidate);
    return;
  }

  existing.name ??= candidate.name;
  existing.description ??= candidate.description;
  existing.supportedReasoningEfforts = normalizeReasoningEfforts([
    ...(existing.supportedReasoningEfforts ?? []),
    ...(candidate.supportedReasoningEfforts ?? []),
  ]);
  existing.defaultReasoningEffort ??= candidate.defaultReasoningEffort;
}

function finalizeCatalogModel(
  provider: DownstreamAgentProvider,
  model: CatalogModelEntry,
  options: {
    allowStaticReasoningDefault?: boolean;
  },
): CatalogModelEntry {
  const staticModel = getAgentCatalog(provider).models.find((entry) => entry.id === model.id);
  const name = model.name ?? staticModel?.name;
  const description = model.description ?? staticModel?.description;
  const supportedReasoningEfforts = normalizeReasoningEfforts(model.supportedReasoningEfforts);
  const staticDefaultReasoningEffort = options.allowStaticReasoningDefault
    && staticModel?.defaultReasoningEffort
    && supportedReasoningEfforts?.includes(staticModel.defaultReasoningEffort)
    ? staticModel.defaultReasoningEffort
    : undefined;

  return {
    id: model.id,
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    ...(supportedReasoningEfforts ? { supportedReasoningEfforts } : {}),
    ...((model.defaultReasoningEffort ?? staticDefaultReasoningEffort)
      ? { defaultReasoningEffort: model.defaultReasoningEffort ?? staticDefaultReasoningEffort }
      : {}),
  };
}

function normalizeReasoningEfforts(
  efforts: Iterable<string> | undefined,
): ReasoningEffort[] | undefined {
  if (!efforts) {
    return undefined;
  }

  const supportedEfforts = new Set<ReasoningEffort>();
  for (const effort of efforts) {
    if (isReasoningEffort(effort)) {
      supportedEfforts.add(effort);
    }
  }

  const ordered = REASONING_EFFORTS.filter((effort) => supportedEfforts.has(effort));
  return ordered.length > 0 ? ordered : undefined;
}

function normalizeOptionalLabel(
  value: string | null | undefined,
  fallbackId: string,
): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed !== fallbackId ? trimmed : undefined;
}

function normalizeOptionalText(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
