import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const TIMING_TRACE_DIR = "timing-traces";

export interface RunTimingTrace {
  rootDir: string;
  traceId: string;
  shared: {
    firstAgentActionRecorded: boolean;
  };
}

export interface TimingTraceEvent {
  timestamp: string;
  atMs: number;
  source: string;
  name: string;
  details?: Record<string, unknown>;
}

export function createRunTimingTrace(rootDir: string, traceId: string): RunTimingTrace {
  return {
    rootDir,
    traceId,
    shared: {
      firstAgentActionRecorded: false,
    },
  };
}

export function buildTimingTracePath(rootDir: string, traceId: string): string {
  return join(rootDir, TIMING_TRACE_DIR, `${traceId}.jsonl`);
}

export function appendTimingTraceEvent(
  trace: RunTimingTrace | undefined,
  source: string,
  name: string,
  details?: Record<string, unknown>,
): void {
  if (!trace) {
    return;
  }

  const entry: TimingTraceEvent = {
    timestamp: new Date().toISOString(),
    atMs: Date.now(),
    source,
    name,
    ...(details ? { details } : {}),
  };
  const path = buildTimingTracePath(trace.rootDir, trace.traceId);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf8");
}

export function readTimingTrace(rootDir: string, traceId: string): TimingTraceEvent[] {
  const path = buildTimingTracePath(rootDir, traceId);
  const content = readFileSync(path, "utf8");
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TimingTraceEvent);
}
