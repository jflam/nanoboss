import {
  buildReasoningModelSelection,
  isReasoningEffort,
  parseReasoningModelSelection,
  resolveDefaultDownstreamAgentConfig,
  type ReasoningEffort,
} from "@nanoboss/agent-acp";
import { readPersistedDefaultAgentSelection } from "@nanoboss/store";
import type {
  DownstreamAgentConfig,
  DownstreamAgentProvider,
  DownstreamAgentSelection,
} from "@nanoboss/procedure-sdk";

interface ParsedModelSelection {
  modelId: string;
  reasoningEffort?: ReasoningEffort;
}

export function resolveDownstreamAgentConfig(
  cwd?: string,
  selection?: DownstreamAgentSelection,
): DownstreamAgentConfig {
  if (!selection) {
    if (!hasExplicitEnvOverride()) {
      const persistedSelection = readPersistedDefaultAgentSelection();
      if (persistedSelection) {
        return resolveDownstreamAgentConfig(cwd, persistedSelection);
      }
    }

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
    ? config.provider === "copilot"
      ? buildReasoningModelSelection(
          config.model,
          config.reasoningEffort && isReasoningEffort(config.reasoningEffort)
            ? config.reasoningEffort
            : undefined,
        )
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

function hasExplicitEnvOverride(): boolean {
  return Boolean(
    process.env.NANOBOSS_AGENT_CMD?.trim()
      || process.env.NANOBOSS_AGENT_ARGS?.trim()
      || process.env.NANOBOSS_AGENT_MODEL?.trim(),
  );
}
