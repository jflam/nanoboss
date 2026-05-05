import {
  cancelSessionContinuation,
  cancelSessionRun,
  type FrontendEventEnvelope,
} from "@nanoboss/adapters-http";

import type { UiAction } from "../reducer/reducer-actions.ts";
import type { UiState } from "../state/state.ts";

export interface ControllerStopDeps {
  cancelSessionRun?: typeof cancelSessionRun;
  cancelSessionContinuation?: typeof cancelSessionContinuation;
}

type Dispatch = (action: UiAction) => void;

export async function cancelActiveRun(params: {
  state: UiState;
  dispatch: Dispatch;
  handleContinuationCancel: () => Promise<void>;
  sendStopRequest: (runId: string) => Promise<void>;
}): Promise<void> {
  if (!params.state.sessionId) {
    return;
  }

  if (params.state.inputDisabledReason !== "run") {
    if (!params.state.inputDisabled && params.state.pendingContinuation) {
      await params.handleContinuationCancel();
    }
    return;
  }

  const activeRunId = params.state.activeRunId;
  const stopAlreadyLatched = params.state.pendingStopRequest
    || (activeRunId !== undefined && params.state.stopRequestedRunId === activeRunId);
  if (stopAlreadyLatched) {
    return;
  }

  params.dispatch({
    type: "local_stop_requested",
    runId: activeRunId,
  });

  if (activeRunId) {
    await params.sendStopRequest(activeRunId);
  }
}

export async function handleContinuationCancel(params: {
  deps: ControllerStopDeps;
  serverUrl: string;
  state: UiState;
  dispatch: Dispatch;
}): Promise<void> {
  const sessionId = params.state.sessionId;
  if (!sessionId || !params.state.pendingContinuation) {
    return;
  }

  try {
    await (params.deps.cancelSessionContinuation ?? cancelSessionContinuation)(
      params.serverUrl,
      sessionId,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    params.dispatch({
      type: "local_status",
      text: `[run] continuation cancel failed: ${message}`,
    });
  }
}

export function maybeSendLatchedStopRequest(params: {
  event: FrontendEventEnvelope;
  state: UiState;
  sendStopRequest: (runId: string) => void;
}): void {
  if (params.event.type !== "run_started" || params.state.stopRequestedRunId !== params.event.data.runId) {
    return;
  }

  params.sendStopRequest(params.event.data.runId);
}

export async function sendStopRequest(params: {
  deps: ControllerStopDeps;
  serverUrl: string;
  state: UiState;
  runId: string;
  dispatch: Dispatch;
}): Promise<void> {
  const sessionId = params.state.sessionId;
  if (!sessionId) {
    return;
  }

  try {
    await (params.deps.cancelSessionRun ?? cancelSessionRun)(
      params.serverUrl,
      sessionId,
      params.runId,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    params.dispatch({
      type: "local_stop_request_failed",
      runId: params.runId,
      text: `[run] cancel failed: ${message}`,
    });
  }
}
