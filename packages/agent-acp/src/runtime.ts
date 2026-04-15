import * as acp from "@agentclientprotocol/sdk";
import { appendFileSync, mkdirSync } from "node:fs";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";

import { getAgentTranscriptDir, getNanobossHome } from "./config.ts";
import type { DownstreamAgentConfig } from "./types.ts";

export type AcpSessionUpdateHandler = (params: acp.SessionNotification) => Promise<void> | void;

export interface OpenAcpConnection {
  child: ChildProcessByStdio<Writable, Readable, Readable>;
  connection: acp.ClientSideConnection;
  capabilities?: acp.AgentCapabilities;
  cwd: string;
  transcriptPath: string;
  writeEvent(entry: Record<string, unknown>): void;
  setSessionUpdateHandler(handler: AcpSessionUpdateHandler | undefined): void;
}

export async function openAcpConnection(config: DownstreamAgentConfig): Promise<OpenAcpConnection> {
  const cwd = config.cwd ?? process.cwd();
  const transcriptPath = createTranscriptPath();
  let sessionUpdateHandler: AcpSessionUpdateHandler | undefined;

  mkdirSync(getAgentTranscriptDir(), { recursive: true });

  const writeEvent = (entry: Record<string, unknown>) => {
    appendFileSync(
      transcriptPath,
      `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`,
      "utf8",
    );
  };

  writeEvent({
    event: "spawn",
    provider: config.provider,
    model: config.model,
    reasoningEffort: config.reasoningEffort,
    command: config.command,
    args: config.args,
    cwd,
  });

  const child: ChildProcessByStdio<Writable, Readable, Readable> = spawn(
    config.command,
    config.args,
    {
      cwd,
      env: {
        ...process.env,
        ...config.env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  child.stderr.on("data", (chunk: Buffer | string) => {
    writeEvent({
      stream: "stderr",
      text: chunk.toString(),
    });
  });

  const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdin),
    Readable.toWeb(child.stdout),
  );

  const client: acp.Client = {
    async requestPermission(params) {
      const blockedReason = describeBlockedNanobossAccess(params.toolCall);
      if (blockedReason) {
        writeEvent({
          event: "permission",
          toolCall: params.toolCall,
          selected: "cancelled",
          blockedReason,
        });
        return { outcome: { outcome: "cancelled" } };
      }

      const selected =
        params.options.find((option) => option.kind.startsWith("allow")) ??
        params.options[0];

      if (!selected) {
        return { outcome: { outcome: "cancelled" } };
      }

      writeEvent({
        event: "permission",
        toolCall: params.toolCall,
        selected: selected.optionId,
      });

      return {
        outcome: {
          outcome: "selected",
          optionId: selected.optionId,
        },
      };
    },
    async sessionUpdate(params) {
      await sessionUpdateHandler?.(params);
    },
  };

  const connection = new acp.ClientSideConnection(() => client, stream);

  try {
    const initialized = await connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    writeEvent({
      event: "initialized",
      protocolVersion: initialized.protocolVersion,
      agentCapabilities: initialized.agentCapabilities,
      authMethods: initialized.authMethods,
    });

    return {
      child,
      connection,
      capabilities: initialized.agentCapabilities,
      cwd,
      transcriptPath,
      writeEvent,
      setSessionUpdateHandler(handler) {
        sessionUpdateHandler = handler;
      },
    };
  } catch (error) {
    child.kill();
    throw error;
  }
}

export function closeAcpConnection(state: OpenAcpConnection): void {
  state.setSessionUpdateHandler(undefined);
  state.child.kill();
}

export async function applyAcpSessionConfig(
  connection: acp.ClientSideConnection,
  sessionId: acp.SessionId,
  config: DownstreamAgentConfig,
): Promise<void> {
  if (config.model) {
    await connection.unstable_setSessionModel({
      sessionId,
      modelId: config.model,
    });
  }

  if (config.reasoningEffort) {
    await connection.setSessionConfigOption({
      sessionId,
      configId: "reasoning_effort",
      value: config.reasoningEffort,
    });
  }
}

function createTranscriptPath(): string {
  return join(getAgentTranscriptDir(), `${crypto.randomUUID()}.jsonl`);
}

export function describeBlockedNanobossAccess(toolCall: unknown): string | undefined {
  const strings = collectStringLeaves(toolCall);

  if (strings.some((value) => referencesAgentTranscriptDir(value))) {
    return "Direct access to ~/.nanoboss/agent-logs is blocked to avoid recursive transcript blowups. Use durable session cells/refs through the global `nanoboss` MCP tools instead.";
  }

  if (isBroadNanobossHomeShellAccess(toolCall, strings)) {
    return "Broad access to ~/.nanoboss is blocked because it can recurse into live agent transcripts. Use the `nanoboss` MCP tools or scope filesystem fallback to ~/.nanoboss/sessions/<sessionId> or current-sessions.json.";
  }

  return undefined;
}

function isBroadNanobossHomeShellAccess(toolCall: unknown, strings: string[]): boolean {
  const record = asRecord(toolCall);
  const kind = typeof record?.kind === "string" ? record.kind : undefined;
  if (kind !== "search" && kind !== "execute") {
    return false;
  }

  return strings.some((value) => referencesBroadNanobossHomeTarget(value));
}

function referencesAgentTranscriptDir(value: string): boolean {
  const normalized = normalizePathLikeString(value);
  return normalized.includes(normalizePathLikeString(getAgentTranscriptDir()))
    || normalized.includes("~/.nanoboss/agent-logs");
}

function referencesBroadNanobossHomeTarget(value: string): boolean {
  return matchesExactPathToken(value, getNanobossHome())
    || matchesExactPathToken(value, "~/.nanoboss");
}

function matchesExactPathToken(value: string, target: string): boolean {
  const escaped = escapeRegExp(target);
  return new RegExp("(^|[\\s\"'=:(])" + escaped + "(?=$|[\\s\"'`;|&)])").test(value);
}

function normalizePathLikeString(value: string): string {
  return value.replaceAll("\\", "/");
}

function collectStringLeaves(value: unknown, seen = new Set<unknown>()): string[] {
  if (typeof value === "string") {
    return [value];
  }

  if (!value || typeof value !== "object") {
    return [];
  }

  if (seen.has(value)) {
    return [];
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectStringLeaves(entry, seen));
  }

  return Object.values(value).flatMap((entry) => collectStringLeaves(entry, seen));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
