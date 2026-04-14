import type * as acp from "@agentclientprotocol/sdk";
import type { ReplayableFrontendEvent } from "../http/frontend-events.ts";
import type { CellRef, ValueRef } from "../session/store-refs.ts";
import {
  cellRefFromRunRef,
  refFromValueRef,
  runRefFromCellRef,
  valueRefFromRef,
} from "../session/store-refs.ts";

export type KernelScalar = null | boolean | number | string;
export type JsonValue = KernelScalar | JsonValue[] | { [key: string]: JsonValue };

export interface RunRef {
  sessionId: string;
  runId: string;
}

export interface Ref {
  run: RunRef;
  path: string;
}

export interface SessionRef {
  sessionId: string;
}

export interface SessionDescriptor {
  session: SessionRef;
  cwd: string;
  defaultAgentSelection?: DownstreamAgentSelection;
}

export interface SessionMetadataRecord {
  session: SessionRef;
  cwd: string;
  rootDir: string;
  createdAt: string;
  updatedAt: string;
  defaultAgentSelection?: DownstreamAgentSelection;
  defaultAgentSessionId?: string;
  pendingContinuation?: PendingContinuation;
}

export function createRunRef(sessionId: string, runId: string): RunRef {
  return { sessionId, runId };
}

export function createRef(run: RunRef, path: string): Ref {
  return { run, path };
}

export function createSessionRef(sessionId: string): SessionRef {
  return { sessionId };
}

export interface PromptImagePart {
  type: "image";
  token: string;
  mimeType: string;
  data: string;
  width?: number;
  height?: number;
  byteLength?: number;
}

export type PromptPart =
  | {
      type: "text";
      text: string;
    }
  | PromptImagePart;

export interface PromptInput {
  parts: PromptPart[];
}

export interface PromptImageSummary {
  token: string;
  mimeType: string;
  width?: number;
  height?: number;
  byteLength?: number;
  attachmentId?: string;
  attachmentPath?: string;
}

export interface ProcedurePromptInput {
  parts: PromptPart[];
  text: string;
  displayText: string;
  images: PromptImageSummary[];
}

export interface Simplify2CheckpointContinuationUiAction {
  id: "approve" | "stop" | "focus_tests" | "other";
  label: string;
  reply?: string;
  description?: string;
}

export interface Simplify2CheckpointContinuationUi {
  kind: "simplify2_checkpoint";
  title: string;
  actions: Simplify2CheckpointContinuationUiAction[];
}

export interface Simplify2FocusPickerContinuationUiEntry {
  id: string;
  title: string;
  subtitle?: string;
  status: "active" | "paused" | "finished" | "archived";
  updatedAt: string;
  lastSummary?: string;
}

export interface Simplify2FocusPickerContinuationUiAction {
  id: "continue" | "archive" | "new" | "cancel";
  label: string;
}

export interface Simplify2FocusPickerContinuationUi {
  kind: "simplify2_focus_picker";
  title: string;
  entries: Simplify2FocusPickerContinuationUiEntry[];
  actions: Simplify2FocusPickerContinuationUiAction[];
}

export type ContinuationUi =
  | Simplify2CheckpointContinuationUi
  | Simplify2FocusPickerContinuationUi;

export interface Continuation<TState extends KernelValue = KernelValue> {
  question: string;
  state: TState;
  inputHint?: string;
  suggestedReplies?: string[];
  ui?: ContinuationUi;
}

export interface FrontendContinuation {
  procedure: string;
  question: string;
  inputHint?: string;
  suggestedReplies?: string[];
  ui?: ContinuationUi;
}

export interface PendingContinuation<TState extends KernelValue = KernelValue> extends Continuation<TState> {
  procedure: string;
  run: RunRef;
}

export type KernelValue =
  | KernelScalar
  | CellRef
  | ValueRef
  | KernelValue[]
  | object;

export type CellKind = "top_level" | "procedure" | "agent";

export type RunKind = CellKind;

export interface RunRecord {
  run: RunRef;
  kind: RunKind;
  procedure: string;
  input: string;
  output: {
    data?: KernelValue;
    display?: string;
    stream?: string;
    summary?: string;
    memory?: string;
    pause?: Continuation;
    explicitDataSchema?: object;
    replayEvents?: PersistedFrontendEvent[];
  };
  meta: {
    createdAt: string;
    parentRunId?: string;
    dispatchCorrelationId?: string;
    defaultAgentSelection?: DownstreamAgentSelection;
    promptImages?: PromptImageSummary[];
  };
}

export interface RunSummary {
  run: RunRef;
  procedure: string;
  kind: RunKind;
  parentRunId?: string;
  summary?: string;
  memory?: string;
  dataRef?: Ref;
  displayRef?: Ref;
  streamRef?: Ref;
  dataShape?: JsonValue;
  explicitDataSchema?: object;
  createdAt: string;
}

export interface RefStat {
  run: RunRef;
  path: string;
  type: string;
  size: number;
  preview?: string;
}

export function publicKernelValueFromStored(value: KernelValue | undefined): KernelValue | undefined {
  if (value === undefined || value === null) {
    return value;
  }

  if (isValueRefLike(value)) {
    return refFromValueRef(value);
  }

  if (isCellRefLike(value)) {
    return runRefFromCellRef(value);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => publicKernelValueFromStored(entry) as KernelValue);
  }

  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, publicKernelValueFromStored(entry as KernelValue)]),
    );
  }

  return value;
}

export function storedKernelValueFromPublic(value: KernelValue | undefined): KernelValue | undefined {
  if (value === undefined || value === null) {
    return value;
  }

  if (isRefLike(value)) {
    return valueRefFromRef(value);
  }

  if (isRunRefLike(value)) {
    return cellRefFromRunRef(value);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => storedKernelValueFromPublic(entry) as KernelValue);
  }

  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, storedKernelValueFromPublic(entry as KernelValue)]),
    );
  }

  return value;
}

function isCellRefLike(value: unknown): value is CellRef {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { sessionId?: unknown }).sessionId === "string" &&
    typeof (value as { cellId?: unknown }).cellId === "string" &&
    !("path" in (value as object))
  );
}

function isValueRefLike(value: unknown): value is ValueRef {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { path?: unknown }).path === "string" &&
    isCellRefLike((value as { cell?: unknown }).cell)
  );
}

function isRunRefLike(value: unknown): value is RunRef {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { sessionId?: unknown }).sessionId === "string" &&
    typeof (value as { runId?: unknown }).runId === "string" &&
    !("path" in (value as object))
  );
}

function isRefLike(value: unknown): value is Ref {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { path?: unknown }).path === "string" &&
    isRunRefLike((value as { run?: unknown }).run)
  );
}

export interface RunFilterOptions {
  kind?: CellKind;
  procedure?: string;
  limit?: number;
}

export interface RunAncestorsOptions {
  includeSelf?: boolean;
  limit?: number;
}

export interface RunDescendantsOptions extends RunFilterOptions {
  maxDepth?: number;
}

export type CellFilterOptions = RunFilterOptions;
export type CellAncestorsOptions = RunAncestorsOptions;
export type CellDescendantsOptions = RunDescendantsOptions;

export interface SessionRecentOptions {
  procedure?: string;
  limit?: number;
}

export type TopLevelRunsOptions = Omit<CellFilterOptions, "kind">;

export interface RefsApi {
  read<T = KernelValue>(ref: Ref): Promise<T>;
  stat(ref: Ref): Promise<RefStat>;
  writeToFile(ref: Ref, path: string): Promise<void>;
}

export interface StateRunsApi {
  recent(options?: SessionRecentOptions): Promise<RunSummary[]>;
  latest(options?: SessionRecentOptions): Promise<RunSummary | undefined>;
  topLevelRuns(options?: TopLevelRunsOptions): Promise<RunSummary[]>;
  get(run: RunRef): Promise<RunRecord>;
  parent(run: RunRef): Promise<RunSummary | undefined>;
  children(run: RunRef, options?: Omit<RunDescendantsOptions, "maxDepth">): Promise<RunSummary[]>;
  ancestors(run: RunRef, options?: RunAncestorsOptions): Promise<RunSummary[]>;
  descendants(run: RunRef, options?: RunDescendantsOptions): Promise<RunSummary[]>;
}

export interface SessionApi {
  /**
   * Live default-agent session control for the current procedure binding.
   *
   * Durable run/cell history lives under `ctx.state`, not `ctx.session`.
   */
  getDefaultAgentConfig(): DownstreamAgentConfig;
  setDefaultAgentSelection(selection: DownstreamAgentSelection): DownstreamAgentConfig;
  getDefaultAgentTokenSnapshot(): Promise<AgentTokenSnapshot | undefined>;
  getDefaultAgentTokenUsage(): Promise<AgentTokenUsage | undefined>;
}

export interface StateApi {
  /**
   * Durable session data and structural traversal over stored run cells.
   *
   * Live default-agent controls live under `ctx.session`, not `ctx.state`.
   */
  readonly runs: StateRunsApi;
  readonly refs: RefsApi;
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

export type PersistedFrontendEvent = ReplayableFrontendEvent;

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
  pause?: Continuation;
  explicitDataSchema?: object;
}

export interface RunResult<T extends KernelValue = KernelValue> {
  run: RunRef;
  data?: T;
  dataRef?: Ref;
  displayRef?: Ref;
  streamRef?: Ref;
  pause?: Continuation;
  pauseRef?: Ref;
  summary?: string;
  rawRef?: Ref;
}

export interface AgentRunResult<T extends KernelValue = KernelValue> extends RunResult<T> {
  durationMs: number;
  raw: string;
  logFile?: string;
  tokenSnapshot?: AgentTokenSnapshot;
}

export interface AgentSession {
  sessionId?: string;
  prompt(prompt: string | PromptInput): Promise<AgentRunResult>;
  warm?(): Promise<void>;
  close(): void;
}

export type ProcedureExecutionMode = "defaultConversation" | "harness";

export interface ProcedureMetadata {
  name: string;
  description: string;
  inputHint?: string;
  executionMode?: ProcedureExecutionMode;
}

export interface DeferredProcedureMetadata extends ProcedureMetadata {
  supportsResume: boolean;
}

export interface Procedure extends ProcedureMetadata {
  execute(prompt: string, ctx: ProcedureApi): Promise<ProcedureResult | string | void>;
  resume?(prompt: string, state: KernelValue, ctx: ProcedureApi): Promise<ProcedureResult | string | void>;
}

export interface ProcedureRegistryLike {
  get(name: string): Procedure | undefined;
  register(procedure: Procedure): void;
  loadProcedureFromPath(path: string): Promise<Procedure>;
  persist(procedureName: string, source: string, cwd: string): Promise<string>;
  listMetadata(): DeferredProcedureMetadata[];
}

export type AgentSessionMode = "fresh" | "default";
export type ProcedureSessionMode = AgentSessionMode | "inherit";

export interface CommandCallAgentOptions {
  /**
   * Session selection for the downstream agent call.
   *
   * - "fresh" starts an isolated ACP session for this invocation.
   * - "default" reuses the current nanoboss session's default ACP conversation.
   *
   * Defaults to "fresh" so isolated one-shot work remains the safe default.
   */
  session?: AgentSessionMode;
  /**
   * Downstream agent selection for this call.
   *
   * In "default" mode this updates the session's default agent selection before
   * continuing the reused conversation.
   */
  agent?: DownstreamAgentSelection;
  stream?: boolean;
  refs?: Record<string, RunRef | Ref>;
  promptInput?: PromptInput;
}

export interface CommandCallProcedureOptions {
  /**
   * Default-conversation binding for the invoked procedure.
   *
   * - "inherit" keeps the caller's current default-conversation binding.
   * - "default" rebinds the child procedure to the top-level/master default conversation.
   * - "fresh" gives the child procedure a private default conversation and private default-agent selection state.
   *
   * Defaults to "inherit" so nested procedures preserve the caller's session behavior unless explicitly changed.
   */
  session?: ProcedureSessionMode;
}

export type UiCardKind = "proposal" | "summary" | "checkpoint" | "report" | "notification";

export interface UiStatusParams {
  procedure?: string;
  phase?: string;
  message: string;
  iteration?: string;
  autoApprove?: boolean;
  waiting?: boolean;
}

export interface UiCardParams {
  kind: UiCardKind;
  title: string;
  markdown: string;
}

export interface UiApi {
  text(text: string): void;
  info(text: string): void;
  warning(text: string): void;
  error(text: string): void;
  status(params: UiStatusParams): void;
  card(params: UiCardParams): void;
}

export interface BoundAgentInvocationApi {
  run(prompt: string, options?: Omit<CommandCallAgentOptions, "session">): Promise<RunResult<string>>;
  run<T extends KernelValue>(
    prompt: string,
    descriptor: TypeDescriptor<T>,
    options?: Omit<CommandCallAgentOptions, "session">,
  ): Promise<RunResult<T>>;
}

export interface AgentInvocationApi {
  run(prompt: string, options?: CommandCallAgentOptions): Promise<RunResult<string>>;
  run<T extends KernelValue>(
    prompt: string,
    descriptor: TypeDescriptor<T>,
    options?: CommandCallAgentOptions,
  ): Promise<RunResult<T>>;
  session(mode: AgentSessionMode): BoundAgentInvocationApi;
}

export interface ProcedureInvocationApi {
  run<T extends KernelValue = KernelValue>(
    name: string,
    prompt: string,
    options?: CommandCallProcedureOptions,
  ): Promise<RunResult<T>>;
}

export interface ProcedureApi {
  readonly cwd: string;
  readonly sessionId: string;
  readonly promptInput?: ProcedurePromptInput;
  readonly agent: AgentInvocationApi;
  /**
   * Durable run state: stored cells, traversal, and refs.
   */
  readonly state: StateApi;
  readonly ui: UiApi;
  readonly procedures: ProcedureInvocationApi;
  /**
   * Live default-agent session control for the current binding.
   */
  readonly session: SessionApi;
  assertNotCancelled(): void;
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
  promptInput?: PromptInput;
}

export interface CallAgentTransport {
  invoke(prompt: string, options: CallAgentOptions): Promise<{
    raw: string;
    logFile?: string;
    updates: acp.SessionUpdate[];
    tokenSnapshot?: AgentTokenSnapshot;
  }>;
}
