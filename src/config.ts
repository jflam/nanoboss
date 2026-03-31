import { homedir } from "node:os";
import { join } from "node:path";

import type { DownstreamAgentConfig, DownstreamAgentProvider, DownstreamAgentSelection } from "./types.ts";

const DEFAULT_AGENT_COMMAND = "copilot";
const DEFAULT_AGENT_ARGS = ["--acp", "--allow-all-tools"];
const COPILOT_REASONING_EFFORTS = ["low", "medium", "high", "xhigh"] as const;

interface ParsedModelSelection {
  raw: string;
  modelId: string;
  reasoningEffort?: string;
}

export function getNanoAgentBossHome(): string {
  return join(homedir(), ".nano-agentboss");
}

export function getRunLogDir(): string {
  return join(getNanoAgentBossHome(), "logs");
}

export function getAgentTranscriptDir(): string {
  return join(getNanoAgentBossHome(), "agent-logs");
}

export function resolveDownstreamAgentConfig(
  cwd?: string,
  selection?: DownstreamAgentSelection,
): DownstreamAgentConfig {
  if (selection) {
    return resolveAgentSelection(selection, cwd);
  }

  const command = process.env.NANO_AGENTBOSS_AGENT_CMD?.trim() || DEFAULT_AGENT_COMMAND;
  const args = parseArgs(process.env.NANO_AGENTBOSS_AGENT_ARGS) ?? DEFAULT_AGENT_ARGS;

  return {
    command,
    args,
    cwd: cwd ?? process.cwd(),
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
