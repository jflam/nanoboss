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
import {
  createAgentCatalogDiscoveryCacheKey,
  getCachedAgentCatalog,
  getCachedAgentCatalogValue,
  getPersistedAgentCatalogValue,
  hasCachedAgentCatalogRefreshedToday,
  setCachedAgentCatalogValue,
  storePendingAgentCatalogDiscovery,
} from "./catalog-discovery-cache.ts";

export interface DiscoverAgentCatalogOptions {
  config?: Partial<Pick<DownstreamAgentConfig, "args" | "command" | "cwd" | "env">>;
  forceRefresh?: boolean;
}

export function formatAgentCatalogRefreshError(
  provider: DownstreamAgentProvider,
  error: unknown,
): string {
  const message = formatCatalogDiscoveryErrorMessage(error);
  return message
    ? `Failed to refresh models from ${provider} harness: ${message}`
    : `Failed to refresh models from ${provider} harness.`;
}

export function hasAgentCatalogRefreshedToday(
  provider: DownstreamAgentProvider,
  options: DiscoverAgentCatalogOptions = {},
): boolean {
  const now = Date.now();
  const config = resolveAgentCatalogDiscoveryConfig(provider, options);
  const cacheKey = createAgentCatalogDiscoveryCacheKey(provider, config);
  return hasCachedAgentCatalogRefreshedToday(cacheKey, now);
}

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

    const persisted = getPersistedAgentCatalogValue(cacheKey, now, true);
    if (persisted) {
      setCachedAgentCatalogValue(cacheKey, persisted);
      return persisted.catalog;
    }
  }

  const fallback = getCachedAgentCatalogValue(cacheKey, now)
    ?? getPersistedAgentCatalogValue(cacheKey, now, true);
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

function formatCatalogDiscoveryErrorMessage(error: unknown): string {
  if (error instanceof AggregateError) {
    const message = error.errors
      .map((entry) => formatCatalogDiscoveryErrorMessage(entry))
      .filter(Boolean)
      .join("; ");
    return message || error.message;
  }

  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
