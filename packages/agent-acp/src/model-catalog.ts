import type { DownstreamAgentProvider } from "@nanoboss/contracts";

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

export interface ParsedModelSelection {
  modelId: string;
  reasoningEffort?: ReasoningEffort;
}

const REASONING_EFFORT_LABELS: Record<ReasoningEffort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
};

const REASONING_EFFORT_DESCRIPTIONS: Record<ReasoningEffort, string> = {
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
        id: "gpt-5.4",
        description: "Latest frontier model with improvements across knowledge, reasoning and coding",
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
        defaultReasoningEffort: "medium",
      },
      {
        id: "gpt-5.3-codex",
        description: "Frontier agentic coding model tuned for code-heavy tasks",
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
        defaultReasoningEffort: "medium",
      },
      {
        id: "gpt-5.2-codex",
        description: "Latest frontier agentic coding model. Balances speed and reasoning depth for everyday tasks",
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
        defaultReasoningEffort: "medium",
      },
      {
        id: "gpt-5.2",
        description: "Latest frontier model with improvements across knowledge, reasoning and coding",
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
        defaultReasoningEffort: "medium",
      },
      {
        id: "gpt-5.1-codex-max",
        description: "Codex-optimized flagship for deep and fast reasoning",
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
        defaultReasoningEffort: "medium",
      },
      {
        id: "gpt-5.1",
        description: "Previous-generation frontier model for general reasoning and coding",
        supportedReasoningEfforts: ["low", "medium", "high"],
        defaultReasoningEffort: "medium",
      },
      {
        id: "gpt-5.1-codex-mini",
        description: "Optimized for Codex. Cheaper, faster, but less capable",
        supportedReasoningEfforts: ["medium", "high"],
        defaultReasoningEffort: "medium",
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
        defaultReasoningEffort: "medium",
      },
      {
        id: "claude-opus-4.6-1m",
        supportedReasoningEfforts: ["low", "medium", "high"],
        defaultReasoningEffort: "medium",
      },
      { id: "claude-opus-4.5" },
      { id: "claude-sonnet-4" },
      {
        id: "goldeneye",
        supportedReasoningEfforts: ["low", "medium", "high"],
        defaultReasoningEffort: "medium",
      },
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
        id: "gpt-5.4-mini",
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
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

export function listSelectableModelOptionsFromCatalog(
  catalog: Pick<AgentCatalogEntry, "models">,
): SelectableModelOption[] {
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

export function findSelectableModelOptionInCatalog(
  catalog: Pick<AgentCatalogEntry, "models">,
  selection: string,
): SelectableModelOption | undefined {
  const trimmed = selection.trim();
  if (!trimmed) {
    return undefined;
  }

  const direct = listSelectableModelOptionsFromCatalog(catalog).find((option) => option.value === trimmed);
  if (direct) {
    return direct;
  }

  const { baseModel } = parseReasoningModelSelection(trimmed);
  if (!baseModel) {
    return undefined;
  }

  const model = catalog.models.find((entry) => entry.id === baseModel);
  if (!model) {
    return undefined;
  }

  return {
    value: trimmed,
    label: formatBaseModelLabel(model),
    description: model.description,
  };
}

export function isKnownModelSelectionInCatalog(
  catalog: Pick<AgentCatalogEntry, "models">,
  selection: string,
): boolean {
  const trimmed = selection.trim();
  if (!trimmed) {
    return false;
  }

  const directMatch = catalog.models.some((model) => model.id === trimmed);
  if (directMatch) {
    return true;
  }

  const { baseModel, reasoningEffort } = parseReasoningModelSelection(trimmed);
  if (!baseModel) {
    return false;
  }

  const baseEntry = catalog.models.find((model) => model.id === baseModel);
  if (!baseEntry) {
    return false;
  }

  if (!reasoningEffort) {
    return true;
  }

  return (baseEntry.supportedReasoningEfforts ?? []).includes(reasoningEffort);
}

function buildReasoningModelSelection(
  modelId: string,
  reasoningEffort?: ReasoningEffort,
): string {
  return reasoningEffort ? `${modelId}/${reasoningEffort}` : modelId;
}

export function buildAgentModelSelection(
  provider: DownstreamAgentProvider,
  modelId: string,
  reasoningEffort?: string,
): string {
  return provider === "copilot" && reasoningEffort && isReasoningEffort(reasoningEffort)
    ? buildReasoningModelSelection(modelId, reasoningEffort)
    : modelId;
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

export function parseAgentModelSelection(
  provider: DownstreamAgentProvider,
  selector: string,
): ParsedModelSelection {
  const raw = selector.trim();
  if (!raw) {
    return { modelId: raw };
  }

  if (provider !== "copilot") {
    return { modelId: raw };
  }

  const { baseModel, reasoningEffort } = parseReasoningModelSelection(raw);
  return {
    modelId: baseModel ?? raw,
    reasoningEffort,
  };
}

function formatBaseModelLabel(model: CatalogModelEntry): string {
  if (model.name && model.name !== model.id) {
    return `${model.name} (${model.id})`;
  }

  return model.id;
}
