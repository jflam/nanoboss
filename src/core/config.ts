import { homedir } from "node:os";
import { join } from "node:path";

import { readPersistedDefaultAgentSelection } from "./settings.ts";
import type { DownstreamAgentConfig, DownstreamAgentProvider, DownstreamAgentSelection } from "./types.ts";

const DEFAULT_AGENT_COMMAND = "copilot";
const DEFAULT_AGENT_ARGS = ["--acp", "--allow-all-tools"];
const COPILOT_REASONING_EFFORTS = ["low", "medium", "high", "xhigh"] as const;

interface ParsedModelSelection {
  raw: string;
  modelId: string;
  reasoningEffort?: string;
}

export function getNanobossHome(): string {
  return join(process.env.HOME?.trim() || homedir(), ".nanoboss");
}

export function getRunLogDir(): string {
  return join(getNanobossHome(), "logs");
}

export function getSessionDir(sessionId: string): string {
  return join(getNanobossHome(), "sessions", sessionId);
}

export function getAgentTranscriptDir(): string {
  return join(getNanobossHome(), "agent-logs");
}

export function getProcedureRuntimeDir(): string {
  return join(getNanobossHome(), "runtime");
}

export function resolveDownstreamAgentConfig(
  cwd?: string,
  selection?: DownstreamAgentSelection,
): DownstreamAgentConfig {
  if (selection) {
    return resolveAgentSelection(selection, cwd);
  }

  if (!hasExplicitEnvOverride()) {
    const persistedSelection = readPersistedDefaultAgentSelection();
    if (persistedSelection) {
      return resolveAgentSelection(persistedSelection, cwd);
    }
  }

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
    cwd: cwd ?? process.cwd(),
    model: parsedModel?.modelId,
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
    ? config.provider === "copilot" && config.reasoningEffort
      ? `${config.model}/${config.reasoningEffort}`
      : config.model
    : undefined;

  return {
    provider: config.provider,
    model,
  };
}

export function parseAgentModelSelection(
  provider: DownstreamAgentProvider,
  selector: string,
): ParsedModelSelection {
  const raw = selector.trim();
  if (!raw) {
    return { raw, modelId: raw };
  }

  if (provider === "copilot") {
    const separator = raw.lastIndexOf("/");
    if (separator > 0 && separator < raw.length - 1) {
      const modelId = raw.slice(0, separator);
      const reasoningEffort = raw.slice(separator + 1);
      if (COPILOT_REASONING_EFFORTS.includes(
        reasoningEffort as typeof COPILOT_REASONING_EFFORTS[number],
      )) {
        return {
          raw,
          modelId,
          reasoningEffort,
        };
      }
    }
  }

  return { raw, modelId: raw };
}

function resolveAgentSelection(
  selection: DownstreamAgentSelection,
  cwd?: string,
): DownstreamAgentConfig {
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
    process.env.NANOBOSS_AGENT_CMD?.trim() ||
      process.env.NANOBOSS_AGENT_ARGS?.trim() ||
      process.env.NANOBOSS_AGENT_MODEL?.trim(),
  );
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
