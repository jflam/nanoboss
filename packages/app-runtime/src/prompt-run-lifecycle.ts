import {
  appendTimingTraceEvent,
  createRunTimingTrace,
} from "@nanoboss/app-support";
import type { SessionUpdateEmitter } from "@nanoboss/procedure-engine";
import {
  RunCancelledError,
  defaultCancellationMessage,
  type PromptInput,
  promptInputDisplayText,
} from "@nanoboss/procedure-sdk";

import { createActiveRunState, startRunHeartbeat } from "./active-run.ts";
import { CompositeSessionUpdateEmitter } from "./composite-session-update-emitter.ts";
import { capturePersistedRuntimeEvents } from "./replay.ts";
import type { SessionState } from "./session-runtime.ts";

export function startPromptRun(params: {
  sessionId: string;
  session: SessionState;
  procedureName: string;
  commandPromptInput: PromptInput;
  hasProcedure: boolean;
  mode: "direct" | "resume";
  delegate?: SessionUpdateEmitter;
}) {
  const activeRun = createActiveRunState();
  params.session.activeRun = activeRun;
  const runId = activeRun.runId;
  const timingTrace = params.hasProcedure
    ? createRunTimingTrace(params.session.store.rootDir, runId)
    : undefined;
  appendTimingTraceEvent(timingTrace, "service", "submit_received", {
    runId,
    procedure: params.procedureName,
    promptLength: promptInputDisplayText(params.commandPromptInput).length,
    mode: params.mode,
  });

  const assertCanStartBoundary = () => {
    if (activeRun.softStopRequested) {
      throw new RunCancelledError(defaultCancellationMessage("soft_stop"), "soft_stop");
    }

    if (activeRun.abortController.signal.aborted) {
      throw new RunCancelledError(defaultCancellationMessage("abort"), "abort");
    }
  };

  const replayCapture = capturePersistedRuntimeEvents(params.session.events, runId);
  const heartbeat = startRunHeartbeat({
    eventLog: params.session.events,
    sessionId: params.sessionId,
    runId,
    procedure: params.procedureName,
  });
  const { markRunActivity } = heartbeat;

  params.session.events.publish(params.sessionId, {
    type: "run_started",
    runId,
    procedure: params.procedureName,
    prompt: promptInputDisplayText(params.commandPromptInput),
    startedAt: new Date().toISOString(),
  });
  markRunActivity();

  const emitter = new CompositeSessionUpdateEmitter(
    params.sessionId,
    runId,
    params.procedureName,
    params.session.events,
    markRunActivity,
    params.delegate,
  );

  return {
    activeRun,
    runId,
    timingTrace,
    assertCanStartBoundary,
    replayCapture,
    heartbeat,
    markRunActivity,
    emitter,
  };
}
