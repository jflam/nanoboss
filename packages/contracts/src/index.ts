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

export interface SessionDescriptor {
  session: SessionRef;
  cwd: string;
  defaultAgentSelection?: DownstreamAgentSelection;
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

export interface PendingContinuation<TState extends KernelValue = KernelValue> extends Continuation<TState> {
  procedure: string;
  run: RunRef;
}

export interface SessionMetadata {
  session: SessionRef;
  cwd: string;
  rootDir: string;
  createdAt: string;
  updatedAt: string;
  initialPrompt?: string;
  lastPrompt?: string;
  autoApprove?: boolean;
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

export type KernelValue =
  | KernelScalar
  | RunRef
  | Ref
  | KernelValue[]
  | object;

export type RunKind = "top_level" | "procedure" | "agent";

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
    agentUpdates?: unknown[];
    replayEvents?: unknown[];
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

export interface RunFilterOptions {
  kind?: RunKind;
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

export interface RunListOptions {
  scope?: "recent" | "top_level";
  procedure?: string;
  limit?: number;
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

export interface AgentSessionPromptOptions {
  signal?: AbortSignal;
  softStopSignal?: AbortSignal;
}

export interface AgentSessionPromptResult {
  raw: string;
  logFile?: string;
  durationMs: number;
  tokenSnapshot?: AgentTokenSnapshot;
}

export interface AgentSession {
  sessionId?: string;
  getCurrentTokenSnapshot(): Promise<AgentTokenSnapshot | undefined>;
  prompt(prompt: string | PromptInput, options?: AgentSessionPromptOptions): Promise<AgentSessionPromptResult>;
  warm?(): Promise<void>;
  updateConfig(config: DownstreamAgentConfig): void;
  close(): void;
}
