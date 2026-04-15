import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { DownstreamAgentProvider } from "@nanoboss/procedure-sdk";

interface LogEntry {
  timestamp: string;
  runId: string;
  spanId: string;
  parentSpanId?: string;
  procedure: string;
  kind: "procedure_start" | "procedure_end" | "agent_start" | "agent_end" | "print";
  prompt?: string;
  result?: unknown;
  raw?: string;
  durationMs?: number;
  error?: string;
  agentLogFile?: string;
  agentProvider?: DownstreamAgentProvider;
  agentModel?: string;
}

export class RunLogger {
  readonly runId: string;
  readonly filePath: string;

  constructor(runId = crypto.randomUUID(), logDir = getRunLogDir()) {
    this.runId = runId;
    mkdirSync(logDir, { recursive: true });
    this.filePath = join(logDir, `${runId}.jsonl`);
  }

  newSpan(_parentSpanId?: string): string {
    return crypto.randomUUID();
  }

  write(entry: Omit<LogEntry, "timestamp" | "runId">): void {
    const serialized = JSON.stringify({
      timestamp: new Date().toISOString(),
      runId: this.runId,
      ...entry,
    });

    appendFileSync(this.filePath, `${serialized}\n`, "utf8");
  }

  close(): void {}
}

function getRunLogDir(): string {
  return join(process.env.HOME?.trim() || homedir(), ".nanoboss", "logs");
}
