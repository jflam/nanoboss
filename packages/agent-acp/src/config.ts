import { homedir } from "node:os";
import { join } from "node:path";

import type { DownstreamAgentConfig, DownstreamAgentProvider } from "@nanoboss/procedure-sdk";
import { parseReasoningModelSelection, type ReasoningEffort } from "./model-catalog.ts";

const DEFAULT_AGENT_COMMAND = "copilot";
const DEFAULT_AGENT_ARGS = ["--acp", "--allow-all-tools"];

interface ParsedModelSelection {
  modelId: string;
  reasoningEffort?: ReasoningEffort;
}

export function getNanobossHome(): string {
  return join(process.env.HOME?.trim() || homedir(), ".nanoboss");
}

export function getAgentTranscriptDir(): string {
  return join(getNanobossHome(), "agent-logs");
}

export function resolveDefaultDownstreamAgentConfig(cwd = process.cwd()): DownstreamAgentConfig {
  const command = process.env.NANOBOSS_AGENT_CMD?.trim() || DEFAULT_AGENT_COMMAND;
  const args = parseArgs(process.env.NANOBOSS_AGENT_ARGS) ?? DEFAULT_AGENT_ARGS;
  const provider = inferProviderFromCommand(command);
  const parsedModel = provider && process.env.NANOBOSS_AGENT_MODEL?.trim()
    ? parseAgentModelSelection(provider, process.env.NANOBOSS_AGENT_MODEL)
    : undefined;

  return {
    provider,
    command,
    args,
    cwd,
    model: parsedModel?.modelId,
    reasoningEffort: parsedModel?.reasoningEffort,
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

function inferProviderFromCommand(command: string): DownstreamAgentProvider | undefined {
  switch (command) {
    case "claude-code-acp":
      return "claude";
    case "gemini":
      return "gemini";
    case "codex-acp":
      return "codex";
    case "copilot":
      return "copilot";
    default:
      return undefined;
  }
}
function parseArgs(value: string | undefined): string[] | undefined {
  if (!value?.trim()) {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
      return parsed;
    }
  } catch {
    return value.split(/\s+/).filter(Boolean);
  }

  return undefined;
}
