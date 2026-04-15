import { resolveDefaultDownstreamAgentConfig } from "@nanoboss/agent-acp";
import type {
  DownstreamAgentConfig,
  DownstreamAgentProvider,
  DownstreamAgentSelection,
} from "@nanoboss/procedure-sdk";

const REASONING_EFFORTS = ["low", "medium", "high", "xhigh"] as const;

type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

interface ParsedModelSelection {
  modelId: string;
  reasoningEffort?: ReasoningEffort;
}

export function resolveDownstreamAgentConfig(
  cwd?: string,
  selection?: DownstreamAgentSelection,
): DownstreamAgentConfig {
  if (!selection) {
    return resolveDefaultDownstreamAgentConfig(cwd ?? process.cwd());
  }

  const parsedModel = selection.model
    ? parseAgentModelSelection(selection.provider, selection.model)
    : undefined;
  const config = baseAgentConfig(selection.provider);
  return {
    ...config,
    cwd: cwd ?? process.cwd(),
    model: parsedModel?.modelId || undefined,
    reasoningEffort: parsedModel?.reasoningEffort,
  };
}

export function toDownstreamAgentSelection(
  config: DownstreamAgentConfig,
): DownstreamAgentSelection | undefined {
  if (!config.provider) {
    return undefined;
  }

  const model = config.model
    ? config.provider === "copilot" && config.reasoningEffort && isReasoningEffort(config.reasoningEffort)
      ? `${config.model}/${config.reasoningEffort}`
      : config.model
    : undefined;

  return {
    provider: config.provider,
    model,
  };
}

function parseAgentModelSelection(
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

function parseReasoningModelSelection(selection: string | null | undefined): {
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

function isReasoningEffort(value: string): value is ReasoningEffort {
  return REASONING_EFFORTS.includes(value as ReasoningEffort);
}

function baseAgentConfig(provider: DownstreamAgentProvider): DownstreamAgentConfig {
  switch (provider) {
    case "claude":
      return {
        provider,
        command: "claude-code-acp",
        args: [],
        env: {
          ANTHROPIC_API_KEY: "",
          CLAUDE_API_KEY: "",
        },
      };
    case "gemini":
      return {
        provider,
        command: "gemini",
        args: ["--acp"],
      };
    case "codex":
      return {
        provider,
        command: "codex-acp",
        args: [],
      };
    case "copilot":
      return {
        provider,
        command: "copilot",
        args: ["--acp", "--allow-all-tools"],
      };
  }
}
