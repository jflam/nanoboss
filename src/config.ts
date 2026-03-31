import { homedir } from "node:os";
import { join } from "node:path";

import type { DownstreamAgentConfig } from "./types.ts";

const DEFAULT_AGENT_COMMAND = "copilot";
const DEFAULT_AGENT_ARGS = ["--acp", "--allow-all-tools"];

export function getNanoAgentBossHome(): string {
  return join(homedir(), ".nano-agentboss");
}

export function getRunLogDir(): string {
  return join(getNanoAgentBossHome(), "logs");
}

export function getAgentTranscriptDir(): string {
  return join(getNanoAgentBossHome(), "agent-logs");
}

export function resolveDownstreamAgentConfig(cwd?: string): DownstreamAgentConfig {
  const command = process.env.NANO_AGENTBOSS_AGENT_CMD?.trim() || DEFAULT_AGENT_COMMAND;
  const args = parseArgs(process.env.NANO_AGENTBOSS_AGENT_ARGS) ?? DEFAULT_AGENT_ARGS;

  return {
    command,
    args,
    cwd: cwd ?? process.cwd(),
  };
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
