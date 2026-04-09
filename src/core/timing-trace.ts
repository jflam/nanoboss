import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const TIMING_TRACE_DIR = "timing-traces";
const ensuredTimingTraceDirs = new Set<string>();
const pendingTraceLinesByPath = new Map<string, string[]>();
let timingTraceFlushScheduled = false;

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
  ensureTimingTraceDir(path);
  const pendingLines = pendingTraceLinesByPath.get(path);
  if (pendingLines) {
    pendingLines.push(`${JSON.stringify(entry)}\n`);
  } else {
    pendingTraceLinesByPath.set(path, [`${JSON.stringify(entry)}\n`]);
  }

  if (!timingTraceFlushScheduled) {
    timingTraceFlushScheduled = true;
    queueMicrotask(flushPendingTimingTraceWrites);
  }
}

export function readTimingTrace(rootDir: string, traceId: string): TimingTraceEvent[] {
  flushPendingTimingTraceWrites();
  const path = buildTimingTracePath(rootDir, traceId);
  const content = readFileSync(path, "utf8");
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TimingTraceEvent);
}

function ensureTimingTraceDir(path: string): void {
  const dir = dirname(path);
  if (ensuredTimingTraceDirs.has(dir)) {
    return;
  }

  mkdirSync(dir, { recursive: true });
  ensuredTimingTraceDirs.add(dir);
}

function flushPendingTimingTraceWrites(): void {
  timingTraceFlushScheduled = false;
  if (pendingTraceLinesByPath.size === 0) {
    return;
  }

  const pendingEntries = [...pendingTraceLinesByPath.entries()];
  pendingTraceLinesByPath.clear();
  for (const [path, lines] of pendingEntries) {
    appendFileSync(path, lines.join(""), "utf8");
  }
}
