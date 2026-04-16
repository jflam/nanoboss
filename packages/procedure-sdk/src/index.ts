import type {
  AgentTokenSnapshot,
  AgentTokenUsage,
  Continuation,
  DownstreamAgentConfig,
  DownstreamAgentSelection,
  KernelValue,
  PromptImageSummary,
  PromptInput,
  PromptPart,
  Ref,
  RefStat,
  RunAncestorsOptions,
  RunDescendantsOptions,
  RunListOptions,
  RunRecord,
  RunRef,
  RunSummary,
} from "@nanoboss/contracts";

export type {
  AgentTokenSnapshot,
  AgentTokenUsage,
  Continuation,
  ContinuationUi,
  DownstreamAgentConfig,
  DownstreamAgentProvider,
  DownstreamAgentSelection,
  KernelValue,
  PendingContinuation,
  PromptImagePart,
  PromptImageSummary,
  PromptInput,
  PromptPart,
  Ref,
  RefStat,
  RunAncestorsOptions,
  RunDescendantsOptions,
  RunFilterOptions,
  RunKind,
  RunListOptions,
  RunRecord,
  RunRef,
  RunSummary,
  Simplify2CheckpointContinuationUi,
  Simplify2CheckpointContinuationUiAction,
  Simplify2FocusPickerContinuationUi,
  Simplify2FocusPickerContinuationUiAction,
  Simplify2FocusPickerContinuationUiEntry,
} from "@nanoboss/contracts";

export interface ProcedurePromptInput {
  parts: PromptPart[];
  text: string;
  displayText: string;
  images: PromptImageSummary[];
}

export interface RefsApi {
  read<T = KernelValue>(ref: Ref): Promise<T>;
  stat(ref: Ref): Promise<RefStat>;
  writeToFile(ref: Ref, path: string): Promise<void>;
}

export interface StateRunsApi {
  list(options?: RunListOptions): Promise<RunSummary[]>;
  get(run: RunRef): Promise<RunRecord>;
  getAncestors(run: RunRef, options?: RunAncestorsOptions): Promise<RunSummary[]>;
  getDescendants(run: RunRef, options?: RunDescendantsOptions): Promise<RunSummary[]>;
}

export interface SessionApi {
  getDefaultAgentConfig(): DownstreamAgentConfig;
  setDefaultAgentSelection(selection: DownstreamAgentSelection): DownstreamAgentConfig;
  getDefaultAgentTokenSnapshot(): Promise<AgentTokenSnapshot | undefined>;
  getDefaultAgentTokenUsage(): Promise<AgentTokenUsage | undefined>;
  isAutoApproveEnabled?(): boolean;
}

export interface StateApi {
  readonly runs: StateRunsApi;
  readonly refs: RefsApi;
}

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
  display?: string;
  displayRef?: Ref;
  streamRef?: Ref;
  memory?: string;
  pause?: Continuation;
  pauseRef?: Ref;
  summary?: string;
  dataShape?: unknown;
  explicitDataSchema?: object;
  tokenUsage?: AgentTokenUsage;
  defaultAgentSelection?: DownstreamAgentSelection;
  rawRef?: Ref;
}

export function expectData<T extends KernelValue>(
  result: RunResult<T>,
  message = "Missing result data",
): T {
  if (result.data === undefined) {
    throw new Error(message);
  }

  return result.data;
}

export function expectDataRef<T extends KernelValue>(
  result: RunResult<T>,
  message = "Missing result data ref",
): Ref {
  if (!result.dataRef) {
    throw new Error(message);
  }

  return result.dataRef;
}

export interface AgentRunResult<T extends KernelValue = KernelValue> extends RunResult<T> {
  durationMs: number;
  raw: string;
  logFile?: string;
  tokenSnapshot?: AgentTokenSnapshot;
}

export type ProcedureExecutionMode = "agentSession" | "harness";

export interface ProcedureMetadata {
  name: string;
  description: string;
  inputHint?: string;
  executionMode?: ProcedureExecutionMode;
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
  listMetadata(): ProcedureMetadata[];
}

export type AgentSessionMode = "fresh" | "default";
export type ProcedureSessionMode = AgentSessionMode | "inherit";

export interface CommandCallAgentOptions {
  session?: AgentSessionMode;
  persistedSessionId?: string;
  agent?: DownstreamAgentSelection;
  stream?: boolean;
  refs?: Record<string, RunRef | Ref>;
  promptInput?: PromptInput;
}

export interface CommandCallProcedureOptions {
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
  readonly state: StateApi;
  readonly ui: UiApi;
  readonly procedures: ProcedureInvocationApi;
  readonly session: SessionApi;
  assertNotCancelled(): void;
}

export {
  createTaggedJsonLineStream,
  type TaggedJsonLineStream,
  type TaggedJsonLineStreamOptions,
} from "./tagged-json-line-stream.ts";

export {
  defaultCancellationMessage,
  normalizeRunCancelledError,
  RunCancelledError,
  type RunCancellationReason,
} from "./cancellation.ts";

export {
  formatAgentBanner,
} from "./agent-banner.ts";

export {
  formatErrorMessage,
} from "./error-format.ts";

export {
  buildImageTokenLabel,
  createTextPromptInput,
  hasPromptInputContent,
  hasPromptInputImages,
  normalizePromptInput,
  parsePromptInputPayload,
  promptInputAttachmentSummaries,
  promptInputDisplayText,
  promptInputToPlainText,
} from "./prompt-input.ts";

export {
  summarizeText,
} from "./text.ts";
