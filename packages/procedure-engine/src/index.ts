import {
  ProcedureCancelledError,
  ProcedureExecutionError,
  executeProcedure,
} from "./procedure-runner.ts";
import {
  buildRecoveredProcedureSyncPrompt,
  findRecoveredProcedureDispatchRun,
  isProcedureDispatchTimeout,
  procedureDispatchResultFromRecoveredRun,
  syncRecoveredProcedureResultIntoDefaultConversation as syncRecoveredProcedureResultIntoDefaultConversationInternal,
  waitForRecoveredProcedureDispatchRun,
} from "./dispatch/recovery.ts";
import type {
  PreparedDefaultPrompt,
  ProcedureUiEvent,
  RuntimeBindings,
  SessionUpdateEmitter,
} from "./context/shared.ts";
import type { AgentTokenUsage, DownstreamAgentConfig, RunRecord } from "@nanoboss/contracts";
import type {
  AgentSession,
  AgentSessionPromptOptions,
  AgentSessionPromptResult,
} from "@nanoboss/agent-acp";

export {
  buildProcedureDispatchCancelPath,
  buildProcedureDispatchCancelsDir,
  buildProcedureDispatchJobPath,
  buildProcedureDispatchJobsDir,
  clearProcedureDispatchCancellation,
  isProcedureDispatchCancellationRequested,
  ProcedureDispatchJobManager,
  requestProcedureDispatchCancellation,
} from "./dispatch/jobs.ts";

export {
  runProcedureDispatchWorkerCommand,
} from "./dispatch/worker-command.ts";

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
  executeProcedure,
  findRecoveredProcedureDispatchRun,
  isProcedureDispatchTimeout,
  procedureDispatchResultFromRecoveredRun,
  ProcedureCancelledError,
  ProcedureExecutionError,
  waitForRecoveredProcedureDispatchRun,
};

export type { ExecuteProcedureParams } from "./procedure-runner.ts";
export type {
  AgentSession,
  AgentSessionPromptOptions,
  AgentSessionPromptResult,
  PreparedDefaultPrompt,
  ProcedureUiEvent,
  RuntimeBindings,
  SessionUpdateEmitter,
};

export { UiApiImpl } from "./context/ui-api.ts";
export { resolveDownstreamAgentConfig } from "./agent-config.ts";
export {
  createProcedureUiMarkerStream,
  formatProcedureStatusText,
  parseProcedureUiMarker,
  PROCEDURE_UI_MARKER_PREFIX,
  renderProcedureUiMarker,
  toProcedureUiSessionUpdate,
} from "./ui-events.ts";

export async function syncRecoveredProcedureResultIntoDefaultConversation(params: {
  agentSession: AgentSession;
  run: RunRecord;
  signal?: AbortSignal;
  defaultAgentConfig: DownstreamAgentConfig;
}): Promise<AgentTokenUsage | undefined> {
  return await syncRecoveredProcedureResultIntoDefaultConversationInternal(params);
}

export { runProcedureCancelHook } from "./procedure-runner.ts";
