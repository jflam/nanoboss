import type * as acp from "@agentclientprotocol/sdk";
import type { ToolPreviewBlock } from "./tool-call-preview.ts";

export type KernelScalar = null | boolean | number | string;
export type JsonValue = KernelScalar | JsonValue[] | { [key: string]: JsonValue };

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
    memory?: string;
    explicitDataSchema?: object;
    replayEvents?: PersistedFrontendEvent[];
  };
  meta: {
    createdAt: string;
    parentCellId?: string;
    kind: CellKind;
    dispatchCorrelationId?: string;
    defaultAgentSelection?: DownstreamAgentSelection;
  };
}

export interface CellSummary {
  cell: CellRef;
  procedure: string;
  kind: CellKind;
  parentCellId?: string;
  summary?: string;
  memory?: string;
  dataRef?: ValueRef;
  displayRef?: ValueRef;
  streamRef?: ValueRef;
  dataShape?: JsonValue;
  explicitDataSchema?: object;
  createdAt: string;
}

export interface RefStat {
  cell: CellRef;
  path: string;
  type: string;
  size: number;
  preview?: string;
}

export interface CellFilterOptions {
  kind?: CellKind;
  procedure?: string;
  limit?: number;
}

export interface CellAncestorsOptions {
  includeSelf?: boolean;
  limit?: number;
}

export interface CellDescendantsOptions extends CellFilterOptions {
  maxDepth?: number;
}

export interface SessionRecentOptions {
  procedure?: string;
  limit?: number;
}

export type TopLevelRunsOptions = Omit<CellFilterOptions, "kind">;

export interface RefsApi {
  read<T = KernelValue>(valueRef: ValueRef): Promise<T>;
  stat(valueRef: ValueRef): Promise<RefStat>;
  writeToFile(valueRef: ValueRef, path: string): Promise<void>;
}

export interface SessionApi {
  recent(options?: SessionRecentOptions): Promise<CellSummary[]>;
  topLevelRuns(options?: TopLevelRunsOptions): Promise<CellSummary[]>;
  get(cellRef: CellRef): Promise<CellRecord>;
  ancestors(cellRef: CellRef, options?: CellAncestorsOptions): Promise<CellSummary[]>;
  descendants(cellRef: CellRef, options?: CellDescendantsOptions): Promise<CellSummary[]>;
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

export interface AgentTokenSnapshot {
  provider?: DownstreamAgentProvider;
  model?: string;
  sessionId?: string;
  source: "acp_usage_update" | "acp_prompt_response" | "copilot_log" | "copilot_session_state" | "claude_debug";
  capturedAt?: string;
  contextWindowTokens?: number;
  usedContextTokens?: number;
  systemTokens?: number;
  conversationTokens?: number;
  toolDefinitionsTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
}

export interface AgentTokenUsage {
  provider?: DownstreamAgentProvider;
  model?: string;
  sessionId?: string;
  source: AgentTokenSnapshot["source"];
  capturedAt?: string;
  currentContextTokens?: number;
  maxContextTokens?: number;
  systemTokens?: number;
  conversationTokens?: number;
  toolDefinitionsTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTrackedTokens?: number;
}

export type PersistedFrontendEvent =
  | {
      type: "text_delta";
      runId: string;
      text: string;
      stream: "agent";
    }
  | {
      type: "assistant_notice";
      runId: string;
      text: string;
      tone: "info" | "warning" | "error";
    }
  | {
      type: "tool_started";
      runId: string;
      toolCallId: string;
      title: string;
      kind: string;
      status?: string;
      callPreview?: ToolPreviewBlock;
      rawInput?: unknown;
    }
  | {
      type: "tool_updated";
      runId: string;
      toolCallId: string;
      title?: string;
      status: string;
      resultPreview?: ToolPreviewBlock;
      errorPreview?: ToolPreviewBlock;
      durationMs?: number;
      rawOutput?: unknown;
    }
  | {
      type: "token_usage";
      runId: string;
      usage: AgentTokenUsage;
      sourceUpdate: "usage_update" | "tool_call_update" | "run_completed";
      toolCallId?: string;
      status?: string;
    }
  | {
      type: "run_completed";
      runId: string;
      procedure: string;
      completedAt: string;
      cell: CellRef;
      summary?: string;
      display?: string;
      tokenUsage?: AgentTokenUsage;
    }
  | {
      type: "run_failed";
      runId: string;
      procedure: string;
      completedAt: string;
      error: string;
      cell?: CellRef;
    }
  | {
      type: "run_cancelled";
      runId: string;
      procedure: string;
      completedAt: string;
      message: string;
      cell?: CellRef;
    };

export interface TypeDescriptor<T> {
  schema: object;
  validate: (input: unknown) => input is T;
}

type ValidatorResult = boolean | { success: boolean };

export function jsonType<T extends KernelValue>(
  schema: object,
  validator: (input: unknown) => ValidatorResult,
): TypeDescriptor<T>;
export function jsonType<T extends KernelValue>(
  schema?: object,
  validator?: (input: unknown) => ValidatorResult,
): TypeDescriptor<T> {
  if (!schema || !validator) {
    throw new Error(
      "jsonType(...) requires concrete schema and validator arguments, for example jsonType(typia.json.schema<Foo>(), typia.createValidate<Foo>()).",
    );
  }

  return {
    schema,
    validate(input: unknown): input is T {
      const result = validator(input);
      return typeof result === "boolean" ? result : result.success;
    },
  };
}

export interface ProcedureResult<T extends KernelValue = KernelValue> {
  data?: T;
  display?: string;
  summary?: string;
  memory?: string;
  explicitDataSchema?: object;
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
  tokenSnapshot?: AgentTokenSnapshot;
}

export interface Procedure {
  name: string;
  description: string;
  inputHint?: string;
  executionMode?: "defaultConversation" | "harness";
  execute(prompt: string, ctx: CommandContext): Promise<ProcedureResult | string | void>;
}

export interface ProcedureRegistryLike {
  get(name: string): Procedure | undefined;
  register(procedure: Procedure): void;
  loadProcedureFromPath(path: string): Promise<Procedure>;
  persist(procedure: Procedure, source: string, cwd?: string): Promise<string>;
  toAvailableCommands(): acp.AvailableCommand[];
}

export interface CommandCallAgentOptions {
  agent?: DownstreamAgentSelection;
  stream?: boolean;
  refs?: Record<string, CellRef | ValueRef>;
}

export interface CommandContext {
  readonly cwd: string;
  readonly sessionId: string;
  readonly refs: RefsApi;
  readonly session: SessionApi;
  getDefaultAgentConfig(): DownstreamAgentConfig;
  setDefaultAgentSelection(selection: DownstreamAgentSelection): DownstreamAgentConfig;
  getDefaultAgentTokenSnapshot(): Promise<AgentTokenSnapshot | undefined>;
  getDefaultAgentTokenUsage(): Promise<AgentTokenUsage | undefined>;
  assertNotCancelled(): void;
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
  continueDefaultSession(prompt: string): Promise<RunResult<string>>;
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
  softStopSignal?: AbortSignal;
}

export interface CallAgentTransport {
  invoke(prompt: string, options: CallAgentOptions): Promise<{
    raw: string;
    logFile?: string;
    updates: acp.SessionUpdate[];
    tokenSnapshot?: AgentTokenSnapshot;
  }>;
}
