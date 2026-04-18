import type * as acp from "@agentclientprotocol/sdk";
import type { DownstreamAgentProvider } from "@nanoboss/contracts";

import { resolveSelectedDownstreamAgentConfig } from "./config.ts";
import {
  getProviderLabel,
  type AgentCatalogEntry,
  type CatalogModelEntry,
} from "./model-catalog.ts";
import { buildAgentRuntimeSessionRuntime } from "./runtime-capability.ts";
import { closeAcpConnection, openAcpConnection } from "./runtime.ts";
import type { DownstreamAgentConfig } from "./types.ts";

export interface DiscoverAgentCatalogOptions {
  config?: Partial<Pick<DownstreamAgentConfig, "args" | "command" | "cwd" | "env">>;
}

export async function discoverAgentCatalog(
  provider: DownstreamAgentProvider,
  options: DiscoverAgentCatalogOptions = {},
): Promise<AgentCatalogEntry> {
  const config = resolveAgentCatalogDiscoveryConfig(provider, options);
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
    catalog = normalizeDiscoveredAgentCatalog(provider, session);
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

function normalizeDiscoveredAgentCatalog(
  provider: DownstreamAgentProvider,
  session: Pick<acp.NewSessionResponse, "configOptions" | "models">,
): AgentCatalogEntry {
  const modelEntries = new Map<string, CatalogModelEntry>();
  const modelConfig = findModelConfigOption(session.configOptions ?? []);
  const configModels = flattenModelConfigOptions(modelConfig);

  for (const model of session.models?.availableModels ?? []) {
    mergeCatalogModel(modelEntries, {
      id: model.modelId,
      name: normalizeOptionalLabel(model.name, model.modelId),
      description: normalizeOptionalText(model.description),
    });
  }

  for (const model of configModels) {
    mergeCatalogModel(modelEntries, {
      id: model.value,
      name: normalizeOptionalLabel(model.name, model.value),
      description: normalizeOptionalText(model.description),
    });
  }

  const currentModelId = session.models?.currentModelId ?? modelConfig?.currentValue;
  if (currentModelId) {
    const currentConfigModel = configModels.find((model) => model.value === currentModelId);
    mergeCatalogModel(modelEntries, {
      id: currentModelId,
      name: normalizeOptionalLabel(currentConfigModel?.name, currentModelId),
      description: normalizeOptionalText(currentConfigModel?.description),
    });
  }

  return {
    provider,
    label: getProviderLabel(provider),
    models: [...modelEntries.values()],
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
