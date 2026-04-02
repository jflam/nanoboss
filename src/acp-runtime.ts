import * as acp from "@agentclientprotocol/sdk";
import { appendFileSync, mkdirSync } from "node:fs";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";

import { getAgentTranscriptDir } from "./config.ts";
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
