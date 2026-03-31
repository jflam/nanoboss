import type * as acp from "@agentclientprotocol/sdk";
import typia from "typia";

export type KernelScalar = null | boolean | number | string;

export interface CellRef {
  sessionId: string;
  cellId: string;
}

export interface ValueRef {
  cell: CellRef;
  path: string;
}

export type KernelValue =
  | KernelScalar
  | CellRef
  | ValueRef
  | KernelValue[]
  | object;

export type CellKind = "top_level" | "procedure" | "agent";

export interface CellRecord {
  cellId: string;
  procedure: string;
  input: string;
  output: {
    data?: KernelValue;
    display?: string;
    stream?: string;
    summary?: string;
  };
  meta: {
    createdAt: string;
    parentCellId?: string;
    kind: CellKind;
  };
}

export interface CellSummary {
  cell: CellRef;
  procedure: string;
  summary?: string;
  dataRef?: ValueRef;
  displayRef?: ValueRef;
  streamRef?: ValueRef;
  createdAt: string;
}

export interface RefStat {
  cell: CellRef;
  path: string;
  type: string;
  size: number;
  preview?: string;
}

export interface RefsApi {
  read<T = KernelValue>(valueRef: ValueRef): Promise<T>;
  stat(valueRef: ValueRef): Promise<RefStat>;
  writeToFile(valueRef: ValueRef, path: string): Promise<void>;
}

export interface SessionApi {
  last(): Promise<CellSummary | undefined>;
  recent(options?: { procedure?: string; limit?: number }): Promise<CellSummary[]>;
}

export interface DownstreamAgentConfig {
  provider?: DownstreamAgentProvider;
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  model?: string;
  reasoningEffort?: string;
}

export type DownstreamAgentProvider = "claude" | "gemini" | "codex" | "copilot";

export interface DownstreamAgentSelection {
  provider: DownstreamAgentProvider;
  model?: string;
}

export interface TypeDescriptor<T> {
  schema: object;
  validate: (input: unknown) => input is T;
}

export function jsonType<T extends KernelValue>(): TypeDescriptor<T> {
  try {
    const validator = typia.createValidate<T>();

    return {
      schema: typia.json.schema<T>(),
      validate(input: unknown): input is T {
        return validator(input).success;
      },
    };
  } catch (error) {
    if (isTypiaTransformError(error)) {
      throw new Error(
        "jsonType<T>() requires typia's compile-time transform. Ensure bun preload (preload.ts / bun.toml) or ts-patch is configured before calling jsonType<T>().",
        { cause: error },
      );
    }

    throw error;
  }
}

export interface ProcedureResult<T extends KernelValue = KernelValue> {
  data?: T;
  display?: string;
  summary?: string;
}

export interface RunResult<T extends KernelValue = KernelValue> {
  cell: CellRef;
  data?: T;
  dataRef?: ValueRef;
  displayRef?: ValueRef;
  streamRef?: ValueRef;
  summary?: string;
  rawRef?: ValueRef;
}

export interface AgentRunResult<T extends KernelValue = KernelValue> extends RunResult<T> {
  durationMs: number;
  raw: string;
  logFile?: string;
}

export type AgentResult<T extends KernelValue = KernelValue> = AgentRunResult<T>;

export interface Procedure {
  name: string;
  description: string;
  inputHint?: string;
  execute(prompt: string, ctx: CommandContext): Promise<ProcedureResult | string | void>;
}

export interface ProcedureRegistryLike {
  get(name: string): Procedure | undefined;
  register(procedure: Procedure): void;
  loadProcedureFromPath(path: string): Promise<Procedure>;
  persist(procedure: Procedure, source: string): Promise<string>;
  toAvailableCommands(): acp.AvailableCommand[];
}

export interface CommandCallAgentOptions {
  agent?: DownstreamAgentSelection;
  stream?: boolean;
  refs?: Record<string, CellRef | ValueRef>;
}

export interface CommandContext {
  readonly cwd: string;
  readonly refs: RefsApi;
  readonly session: SessionApi;
  callAgent(
    prompt: string,
    options?: CommandCallAgentOptions,
  ): Promise<RunResult<string>>;
  callAgent<T extends KernelValue>(
    prompt: string,
    descriptor: TypeDescriptor<T>,
    options?: CommandCallAgentOptions,
  ): Promise<RunResult<T>>;
  callProcedure<T extends KernelValue = KernelValue>(
    name: string,
    prompt: string,
  ): Promise<RunResult<T>>;
  print(text: string): void;
}

export interface LogEntry {
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

export interface CallAgentOptions {
  config?: DownstreamAgentConfig;
  namedRefs?: Record<string, unknown>;
  onUpdate?: (update: acp.SessionUpdate) => Promise<void> | void;
  signal?: AbortSignal;
}

export interface CallAgentTransport {
  invoke(prompt: string, options: CallAgentOptions): Promise<{
    raw: string;
    logFile?: string;
    updates: acp.SessionUpdate[];
  }>;
}

function isTypiaTransformError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("no transform has been configured");
}
