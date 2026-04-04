import type * as acp from "@agentclientprotocol/sdk";

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

import type { SessionUpdateEmitter } from "./context.ts";
import { compactToolCallInput, compactToolCallOutput } from "./tool-call-preview.ts";
import type { AgentTokenUsage } from "./types.ts";

const PROCEDURE_DISPATCH_PROGRESS_DIR = "procedure-dispatch-progress";

export function buildProcedureDispatchProgressPath(rootDir: string, dispatchId: string): string {
  return join(rootDir, PROCEDURE_DISPATCH_PROGRESS_DIR, `${dispatchId}.jsonl`);
}

export function startProcedureDispatchProgressBridge(
  rootDir: string,
  dispatchId: string,
  emitter: SessionUpdateEmitter,
): () => Promise<void> {
  const progressPath = buildProcedureDispatchProgressPath(rootDir, dispatchId);
  let byteOffset = 0;
  let remainder = "";
  let stopped = false;

  const drain = () => {
    if (!existsSync(progressPath)) {
      return;
    }

    const content = readFileSync(progressPath, "utf8");
    const nextChunk = content.slice(byteOffset);
    if (!nextChunk) {
      return;
    }

    byteOffset = content.length;
    const combined = remainder + nextChunk;
    const lines = combined.split("\n");
    remainder = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      try {
        emitter.emit(JSON.parse(trimmed) as acp.SessionUpdate);
      } catch {
        // Ignore malformed progress updates.
      }
    }
  };

  const interval = setInterval(() => {
    if (!stopped) {
      drain();
    }
  }, 100);

  return async () => {
    stopped = true;
    clearInterval(interval);
    drain();
    try {
      rmSync(progressPath, { force: true });
    } catch {
      // Ignore cleanup errors.
    }
  };
}

export class ProcedureDispatchProgressEmitter implements SessionUpdateEmitter {
  private latestTokenUsage?: AgentTokenUsage;

  constructor(
    private readonly progressPath?: string,
    private readonly onActivity?: () => void,
  ) {}

  emit(update: acp.SessionUpdate): void {
    this.writeProgressUpdate(update);
    this.onActivity?.();

    if (update.sessionUpdate !== "tool_call_update" || update.status !== "completed") {
      return;
    }

    const tokenUsage = extractTokenUsage(update.rawOutput);
    if (tokenUsage) {
      this.latestTokenUsage = tokenUsage;
    }
  }

  flush(): Promise<void> {
    return Promise.resolve();
  }

  get currentTokenUsage(): AgentTokenUsage | undefined {
    return this.latestTokenUsage;
  }

  private writeProgressUpdate(update: acp.SessionUpdate): void {
    if (!this.progressPath) {
      return;
    }

    const sanitized = sanitizeProcedureDispatchProgressUpdate(update);
    if (!sanitized) {
      return;
    }

    mkdirSync(dirname(this.progressPath), { recursive: true });
    appendFileSync(this.progressPath, `${JSON.stringify(sanitized)}\n`, "utf8");
  }
}

function sanitizeProcedureDispatchProgressUpdate(update: acp.SessionUpdate): acp.SessionUpdate | undefined {
  if (update.sessionUpdate === "agent_message_chunk") {
    return update;
  }

  if (update.sessionUpdate === "tool_call") {
    return {
      sessionUpdate: "tool_call",
      toolCallId: update.toolCallId,
      title: update.title,
      kind: update.kind,
      status: update.status,
      rawInput: compactToolCallInput({
        title: update.title,
        kind: String(update.kind),
      }, update.rawInput),
    };
  }

  if (update.sessionUpdate === "tool_call_update") {
    return {
      sessionUpdate: "tool_call_update",
      toolCallId: update.toolCallId,
      title: update.title,
      status: update.status,
      rawOutput: compactToolCallOutput({
        title: update.title,
      }, update.rawOutput),
    };
  }

  return undefined;
}

function extractTokenUsage(value: unknown): AgentTokenUsage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const candidate = (value as { tokenUsage?: unknown }).tokenUsage;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return undefined;
  }

  const source = (candidate as { source?: unknown }).source;
  if (typeof source !== "string") {
    return undefined;
  }

  return candidate as AgentTokenUsage;
}
