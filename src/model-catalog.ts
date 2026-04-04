import type { DownstreamAgentProvider } from "./types.ts";

export const REASONING_EFFORTS = ["low", "medium", "high", "xhigh"] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export interface CatalogModelEntry {
  id: string;
  name?: string;
  description?: string;
  supportedReasoningEfforts?: ReasoningEffort[];
  defaultReasoningEffort?: ReasoningEffort;
}

export interface AgentCatalogEntry {
  provider: DownstreamAgentProvider;
  label: string;
  models: CatalogModelEntry[];
}

export interface SelectableModelOption {
  value: string;
  label: string;
  description?: string;
}

export const REASONING_EFFORT_LABELS: Record<ReasoningEffort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
};

export const REASONING_EFFORT_DESCRIPTIONS: Record<ReasoningEffort, string> = {
  low: "Faster responses, lighter reasoning",
  medium: "Balanced speed and reasoning depth",
  high: "More thorough reasoning, slower responses",
  xhigh: "Maximum reasoning depth",
};

const PROVIDER_ORDER: DownstreamAgentProvider[] = ["claude", "gemini", "codex", "copilot"];

const PROVIDER_LABELS: Record<DownstreamAgentProvider, string> = {
  claude: "Claude",
  gemini: "Gemini",
  codex: "Codex",
  copilot: "Copilot",
};

const AGENT_MODEL_CATALOG: Record<DownstreamAgentProvider, AgentCatalogEntry> = {
  claude: {
    provider: "claude",
    label: "Claude",
    models: [
      {
        id: "default",
        name: "Default",
        description: "Account-dependent default model",
      },
      {
        id: "opus",
        name: "Opus",
        description: "Opus 4.5 - Most capable for complex reasoning",
      },
      {
        id: "sonnet",
        name: "Sonnet",
        description: "Sonnet 4.5 - Best for everyday tasks",
      },
      {
        id: "haiku",
        name: "Haiku",
        description: "Haiku 4.5 - Fastest for quick answers",
      },
      {
        id: "opusplan",
        name: "Opus Plan",
        description: "Hybrid: Opus for planning, Sonnet for execution",
      },
    ],
  },
  gemini: {
    provider: "gemini",
    label: "Gemini",
    models: [
      { id: "gemini-2.5-pro" },
      { id: "gemini-2.5-flash" },
      { id: "gemini-2.5-flash-lite" },
      { id: "gemini-3-pro-preview" },
      { id: "gemini-3-flash-preview" },
    ],
  },
  codex: {
    provider: "codex",
    label: "Codex",
    models: [
      {
        id: "gpt-5.2-codex/low",
        name: "gpt-5.2-codex (low)",
        description: "Latest frontier agentic coding model. Fast responses with lighter reasoning",
      },
      {
        id: "gpt-5.2-codex/medium",
        name: "gpt-5.2-codex (medium)",
        description: "Latest frontier agentic coding model. Balances speed and reasoning depth for everyday tasks",
      },
      {
        id: "gpt-5.2-codex/high",
        name: "gpt-5.2-codex (high)",
        description: "Latest frontier agentic coding model. Greater reasoning depth for complex problems",
      },
      {
        id: "gpt-5.2-codex/xhigh",
        name: "gpt-5.2-codex (xhigh)",
        description: "Latest frontier agentic coding model. Extra high reasoning depth for complex problems",
      },
      {
        id: "gpt-5.1-codex-max/low",
        name: "gpt-5.1-codex-max (low)",
        description: "Codex-optimized flagship for deep and fast reasoning. Fast responses with lighter reasoning",
      },
      {
        id: "gpt-5.1-codex-max/medium",
        name: "gpt-5.1-codex-max (medium)",
        description: "Codex-optimized flagship for deep and fast reasoning. Balances speed and reasoning depth for everyday tasks",
      },
      {
        id: "gpt-5.1-codex-max/high",
        name: "gpt-5.1-codex-max (high)",
        description: "Codex-optimized flagship for deep and fast reasoning. Greater reasoning depth for complex problems",
      },
      {
        id: "gpt-5.1-codex-max/xhigh",
        name: "gpt-5.1-codex-max (xhigh)",
        description: "Codex-optimized flagship for deep and fast reasoning. Extra high reasoning depth for complex problems",
      },
      {
        id: "gpt-5.1-codex-mini/medium",
        name: "gpt-5.1-codex-mini (medium)",
        description: "Optimized for codex. Cheaper, faster, but less capable. Dynamically adjusts reasoning based on the task",
      },
      {
        id: "gpt-5.1-codex-mini/high",
        name: "gpt-5.1-codex-mini (high)",
        description: "Optimized for codex. Cheaper, faster, but less capable. Maximizes reasoning depth for complex or ambiguous problems",
      },
      {
        id: "gpt-5.2/low",
        name: "gpt-5.2 (low)",
        description: "Latest frontier model with improvements across knowledge, reasoning and coding. Balances speed with some reasoning",
      },
      {
        id: "gpt-5.2/medium",
        name: "gpt-5.2 (medium)",
        description: "Latest frontier model with improvements across knowledge, reasoning and coding. Balance of reasoning depth and latency",
      },
      {
        id: "gpt-5.2/high",
        name: "gpt-5.2 (high)",
        description: "Latest frontier model with improvements across knowledge, reasoning and coding. Maximizes reasoning depth",
      },
      {
        id: "gpt-5.2/xhigh",
        name: "gpt-5.2 (xhigh)",
        description: "Latest frontier model with improvements across knowledge, reasoning and coding. Extra high reasoning",
      },
    ],
  },
  copilot: {
    provider: "copilot",
    label: "Copilot",
    models: [
      {
        id: "claude-sonnet-4.6",
        supportedReasoningEfforts: ["low", "medium", "high"],
        defaultReasoningEffort: "medium",
      },
      { id: "claude-sonnet-4.5" },
      { id: "claude-haiku-4.5" },
      {
        id: "claude-opus-4.6",
        supportedReasoningEfforts: ["low", "medium", "high"],
        defaultReasoningEffort: "high",
      },
      {
        id: "claude-opus-4.6-fast",
        supportedReasoningEfforts: ["low", "medium", "high"],
        defaultReasoningEffort: "high",
      },
      { id: "claude-opus-4.5" },
      { id: "claude-sonnet-4" },
      { id: "gemini-3-pro-preview" },
      {
        id: "gpt-5.4",
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
        defaultReasoningEffort: "medium",
      },
      {
        id: "gpt-5.3-codex",
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
        defaultReasoningEffort: "medium",
      },
      {
        id: "gpt-5.2-codex",
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
        defaultReasoningEffort: "high",
      },
      {
        id: "gpt-5.1-codex-max",
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
        defaultReasoningEffort: "medium",
      },
      {
        id: "gpt-5.1-codex",
        supportedReasoningEfforts: ["low", "medium", "high"],
        defaultReasoningEffort: "medium",
      },
      {
        id: "gpt-5.2",
        supportedReasoningEfforts: ["low", "medium", "high"],
        defaultReasoningEffort: "medium",
      },
      {
        id: "gpt-5.1",
        supportedReasoningEfforts: ["low", "medium", "high"],
        defaultReasoningEffort: "medium",
      },
      {
        id: "gpt-5.1-codex-mini",
        supportedReasoningEfforts: ["low", "medium", "high"],
        defaultReasoningEffort: "medium",
      },
      {
        id: "gpt-5-mini",
        supportedReasoningEfforts: ["low", "medium", "high"],
        defaultReasoningEffort: "medium",
      },
      { id: "gpt-4.1" },
    ],
  },
};

export function listKnownProviders(): DownstreamAgentProvider[] {
  return [...PROVIDER_ORDER];
}

export function getProviderLabel(provider: DownstreamAgentProvider): string {
  return PROVIDER_LABELS[provider];
}

export function getAgentCatalog(provider: DownstreamAgentProvider): AgentCatalogEntry {
  return AGENT_MODEL_CATALOG[provider];
}

export function isKnownAgentProvider(value: string): value is DownstreamAgentProvider {
  return Object.prototype.hasOwnProperty.call(AGENT_MODEL_CATALOG, value);
}

export function listSelectableModelOptions(
  provider: DownstreamAgentProvider,
): SelectableModelOption[] {
  const catalog = getAgentCatalog(provider);

  return catalog.models.flatMap((model) => {
    const efforts = model.supportedReasoningEfforts ?? [];
    if (efforts.length === 0) {
      return [
        {
          value: model.id,
          label: formatBaseModelLabel(model),
          description: model.description,
        },
      ];
    }

    return efforts.map((effort) => ({
      value: buildReasoningModelSelection(model.id, effort),
      label: `${formatBaseModelLabel(model)} / ${REASONING_EFFORT_LABELS[effort]} thinking${effort === model.defaultReasoningEffort ? " (default)" : ""}`,
      description: [model.description, REASONING_EFFORT_DESCRIPTIONS[effort]].filter(Boolean).join(". "),
    }));
  });
}

export function findSelectableModelOption(
  provider: DownstreamAgentProvider,
  selection: string,
): SelectableModelOption | undefined {
  const trimmed = selection.trim();
  if (!trimmed) {
    return undefined;
  }

  const direct = listSelectableModelOptions(provider).find((option) => option.value === trimmed);
  if (direct) {
    return direct;
  }

  const { baseModel } = parseReasoningModelSelection(trimmed);
  if (!baseModel) {
    return undefined;
  }

  const model = getAgentCatalog(provider).models.find((entry) => entry.id === baseModel);
  if (!model) {
    return undefined;
  }

  return {
    value: trimmed,
    label: formatBaseModelLabel(model),
    description: model.description,
  };
}

export function isKnownModelSelection(
  provider: DownstreamAgentProvider,
  selection: string,
): boolean {
  const trimmed = selection.trim();
  if (!trimmed) {
    return false;
  }

  const directMatch = getAgentCatalog(provider).models.some((model) => model.id === trimmed);
  if (directMatch) {
    return true;
  }

  const { baseModel, reasoningEffort } = parseReasoningModelSelection(trimmed);
  if (!baseModel) {
    return false;
  }

  const baseEntry = getAgentCatalog(provider).models.find((model) => model.id === baseModel);
  if (!baseEntry) {
    return false;
  }

  if (!reasoningEffort) {
    return true;
  }

  return (baseEntry.supportedReasoningEfforts ?? []).includes(reasoningEffort);
}

export function buildReasoningModelSelection(
  modelId: string,
  reasoningEffort?: ReasoningEffort,
): string {
  return reasoningEffort ? `${modelId}/${reasoningEffort}` : modelId;
}

export function parseReasoningModelSelection(selection: string | null | undefined): {
  baseModel: string | null;
  reasoningEffort?: ReasoningEffort;
} {
  if (!selection) {
    return { baseModel: null };
  }

  const slashIndex = selection.lastIndexOf("/");
  if (slashIndex <= 0) {
    return { baseModel: selection };
  }

  const candidate = selection.slice(slashIndex + 1);
  if (!isReasoningEffort(candidate)) {
    return { baseModel: selection };
  }

  return {
    baseModel: selection.slice(0, slashIndex),
    reasoningEffort: candidate,
  };
}

export function isReasoningEffort(value: string): value is ReasoningEffort {
  return REASONING_EFFORTS.includes(value as ReasoningEffort);
}

function formatBaseModelLabel(model: CatalogModelEntry): string {
  if (model.name && model.name !== model.id) {
    return `${model.name} (${model.id})`;
  }

  return model.id;
}
