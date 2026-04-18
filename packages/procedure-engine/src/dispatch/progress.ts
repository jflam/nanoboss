import type * as acp from "@agentclientprotocol/sdk";

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

import type { ProcedureUiEvent, SessionUpdateEmitter } from "../context/shared.ts";
import type { AgentTokenUsage } from "@nanoboss/contracts";

import { toProcedureUiSessionUpdate } from "../ui-events.ts";

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

  emitUiEvent(event: ProcedureUiEvent): void {
    this.emit(toProcedureUiSessionUpdate(event));
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

    const forwarded = forwardProcedureDispatchProgressUpdate(update);
    if (!forwarded) {
      return;
    }

    mkdirSync(dirname(this.progressPath), { recursive: true });
    appendFileSync(this.progressPath, `${JSON.stringify(forwarded)}\n`, "utf8");
  }
}

function forwardProcedureDispatchProgressUpdate(update: acp.SessionUpdate): acp.SessionUpdate | undefined {
  if (
    update.sessionUpdate === "agent_message_chunk" ||
    update.sessionUpdate === "tool_call" ||
    update.sessionUpdate === "tool_call_update" ||
    update.sessionUpdate === "usage_update"
  ) {
    return update;
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
