import {
  executeTopLevelProcedure as executeTopLevelProcedureInternal,
  TopLevelProcedureCancelledError,
  TopLevelProcedureExecutionError,
} from "./top-level-runner.ts";
import {
  buildRecoveredProcedureSyncPrompt,
  findRecoveredProcedureDispatchRun,
  isProcedureDispatchTimeout,
  procedureDispatchResultFromRecoveredRun,
  syncRecoveredProcedureResultIntoDefaultConversation as syncRecoveredProcedureResultIntoDefaultConversationInternal,
  waitForRecoveredProcedureDispatchRun,
} from "./dispatch/recovery.ts";
import type { PreparedDefaultPrompt, ProcedureUiEvent, SessionUpdateEmitter } from "./context/shared.ts";
import type {
  AgentTokenSnapshot,
  AgentTokenUsage,
  DownstreamAgentConfig,
  DownstreamAgentSelection,
  KernelValue,
  PromptInput,
  RunRecord,
} from "@nanoboss/contracts";
import type {
  Procedure,
  ProcedureApi,
  ProcedureRegistryLike,
  RunResult,
} from "@nanoboss/procedure-sdk";
import type { SessionStore } from "@nanoboss/store";

export {
  buildProcedureDispatchCancelPath,
  buildProcedureDispatchCancelsDir,
  buildProcedureDispatchJobPath,
  buildProcedureDispatchJobsDir,
  clearProcedureDispatchCancellation,
  isProcedureDispatchCancellationRequested,
  ProcedureDispatchJobManager,
  requestProcedureDispatchCancellation,
  runProcedureDispatchWorkerCommand,
} from "./dispatch/jobs.ts";

export {
  buildProcedureDispatchProgressPath,
  ProcedureDispatchProgressEmitter,
  startProcedureDispatchProgressBridge,
} from "./dispatch/progress.ts";

export type {
  ProcedureDispatchJob,
  ProcedureDispatchJobStatus,
  ProcedureDispatchStartResult,
  ProcedureDispatchStatusResult,
} from "./dispatch/jobs.ts";

export {
  buildRecoveredProcedureSyncPrompt,
  findRecoveredProcedureDispatchRun,
  isProcedureDispatchTimeout,
  procedureDispatchResultFromRecoveredRun,
  waitForRecoveredProcedureDispatchRun,
  TopLevelProcedureCancelledError,
  TopLevelProcedureExecutionError,
};

export type { PreparedDefaultPrompt, ProcedureUiEvent, SessionUpdateEmitter };

export { CommandContextImpl } from "./context/context.ts";
export { UiApiImpl } from "./context/ui-api.ts";
export {
  defaultCancellationMessage,
  normalizeRunCancelledError,
  RunCancelledError,
  type RunCancellationReason,
} from "./cancellation.ts";
export {
  formatErrorMessage,
} from "./error-format.ts";
export { RunLogger } from "./logger.ts";
export {
  resolveDownstreamAgentConfig,
  toDownstreamAgentSelection,
} from "./agent-config.ts";
export {
  appendTimingTraceEvent,
  createRunTimingTrace,
  type RunTimingTrace,
} from "./timing-trace.ts";
export {
  inferDataShape,
  stringifyCompactShape,
} from "./data-shape.ts";
export {
  resolveSelfCommand,
  resolveSelfCommandWithRuntime,
} from "./self-command.ts";
export {
  createProcedureUiMarkerStream,
  formatProcedureStatusText,
  parseProcedureUiMarker,
  PROCEDURE_UI_MARKER_PREFIX,
  renderProcedureUiMarker,
  toProcedureUiSessionUpdate,
} from "./ui-events.ts";

export interface ProcedureEngineEmitter {
  emit(update: unknown): void;
  emitUiEvent?(event: unknown): void;
  flush(): Promise<void>;
  readonly currentTokenUsage?: AgentTokenUsage;
}

export interface PreparedProcedurePrompt {
  promptInput: PromptInput;
  markSubmitted?: () => void;
}

export interface ProcedureEngineAgentSessionPromptOptions {
  signal?: AbortSignal;
  softStopSignal?: AbortSignal;
  onUpdate?: (update: unknown) => Promise<void> | void;
  timingTrace?: undefined;
}

export interface ProcedureEngineAgentSessionPromptResult {
  raw: string;
  durationMs: number;
  updates: unknown[];
  tokenSnapshot?: AgentTokenSnapshot;
}

export interface ProcedureEngineAgentSession {
  sessionId?: string;
  currentTokenSnapshot?: AgentTokenSnapshot;
  getCurrentTokenSnapshot(): Promise<AgentTokenSnapshot | undefined>;
  prompt(
    prompt: string | PromptInput,
    options?: ProcedureEngineAgentSessionPromptOptions,
  ): Promise<ProcedureEngineAgentSessionPromptResult>;
  updateConfig?(config: DownstreamAgentConfig): void;
  warm?(timingTrace?: undefined): Promise<void>;
  close(): void;
}

export interface RunProcedureParams {
  cwd: string;
  sessionId: string;
  store: SessionStore;
  registry: ProcedureRegistryLike;
  procedure: Procedure;
  prompt: string;
  promptInput?: PromptInput;
  emitter: ProcedureEngineEmitter;
  signal?: AbortSignal;
  softStopSignal?: AbortSignal;
  agentSession?: ProcedureEngineAgentSession;
  getDefaultAgentConfig: () => DownstreamAgentConfig;
  setDefaultAgentSelection: (selection: DownstreamAgentSelection) => DownstreamAgentConfig;
  isAutoApproveEnabled?: () => boolean;
  prepareDefaultPrompt?: (promptInput: PromptInput) => PreparedProcedurePrompt;
  onError?: (ctx: ProcedureApi, errorText: string) => void | Promise<void>;
  dispatchCorrelationId?: string;
  assertCanStartBoundary?: () => void;
  timingTrace?: unknown;
}

export interface ResumeProcedureParams extends RunProcedureParams {
  state: KernelValue;
}

export async function runProcedure(params: RunProcedureParams): Promise<RunResult> {
  type ExecuteTopLevelProcedureParams = Parameters<typeof executeTopLevelProcedureInternal>[0];

  return await executeTopLevelProcedureInternal({
    ...params,
    agentSession: params.agentSession as ExecuteTopLevelProcedureParams["agentSession"],
    timingTrace: params.timingTrace as ExecuteTopLevelProcedureParams["timingTrace"],
  });
}

export async function resumeProcedure(params: ResumeProcedureParams): Promise<RunResult> {
  type ExecuteTopLevelProcedureParams = Parameters<typeof executeTopLevelProcedureInternal>[0];

  return await executeTopLevelProcedureInternal({
    ...params,
    agentSession: params.agentSession as ExecuteTopLevelProcedureParams["agentSession"],
    timingTrace: params.timingTrace as ExecuteTopLevelProcedureParams["timingTrace"],
    resume: {
      prompt: params.prompt,
      state: params.state,
    },
  });
}

export async function syncRecoveredProcedureResultIntoDefaultConversation(params: {
  agentSession: ProcedureEngineAgentSession;
  run: RunRecord;
  signal?: AbortSignal;
  defaultAgentConfig: DownstreamAgentConfig;
}): Promise<AgentTokenUsage | undefined> {
  type SyncRecoveredProcedureParams = Parameters<typeof syncRecoveredProcedureResultIntoDefaultConversationInternal>[0];

  return await syncRecoveredProcedureResultIntoDefaultConversationInternal({
    ...params,
    agentSession: params.agentSession as SyncRecoveredProcedureParams["agentSession"],
  });
}
