import type { AgentTokenUsage } from "@nanoboss/contracts";
import type {
  DownstreamAgentSelection,
  RunRef,
  RunResult,
} from "@nanoboss/procedure-sdk";

import { CompositeSessionUpdateEmitter } from "./composite-session-update-emitter.ts";
import { materializeProcedureMemoryCard } from "./memory-cards.ts";
import {
  buildRunCancelledEvent,
  buildRunCompletedEvent,
  buildRunPausedEvent,
} from "./run-events.ts";
import type { SessionState } from "./session-runtime.ts";

export function publishRunCompleted(params: {
  session: SessionState;
  sessionId: string;
  runId: string;
  procedure: string;
  result: RunResult;
  tokenUsage?: AgentTokenUsage;
  emitter: CompositeSessionUpdateEmitter;
  markRunActivity: () => void;
  applyDefaultAgentSelection: (selection: DownstreamAgentSelection | undefined) => void;
}): void {
  params.applyDefaultAgentSelection(params.result.defaultAgentSelection);
  emitDisplayIfNeeded(params.emitter, params.result.display);
  publishStoredMemoryCard(params.session, params.sessionId, params.runId, params.result.run);
  if (params.tokenUsage) {
    params.session.events.publish(params.sessionId, {
      type: "token_usage",
      runId: params.runId,
      usage: params.tokenUsage,
      sourceUpdate: "run_completed",
    });
  }
  params.session.events.publish(
    params.sessionId,
    buildRunCompletedEvent({
      runId: params.runId,
      procedure: params.procedure,
      result: params.result,
      tokenUsage: params.tokenUsage,
    }),
  );
  params.markRunActivity();
}

export function publishRunPaused(params: {
  session: SessionState;
  sessionId: string;
  runId: string;
  procedure: string;
  result: RunResult;
  tokenUsage?: AgentTokenUsage;
  emitter: CompositeSessionUpdateEmitter;
  markRunActivity: () => void;
  applyDefaultAgentSelection: (selection: DownstreamAgentSelection | undefined) => void;
}): void {
  params.applyDefaultAgentSelection(params.result.defaultAgentSelection);
  emitDisplayIfNeeded(
    params.emitter,
    params.result.display ?? params.result.pause?.question,
  );
  publishStoredMemoryCard(params.session, params.sessionId, params.runId, params.result.run);
  if (params.tokenUsage) {
    params.session.events.publish(params.sessionId, {
      type: "token_usage",
      runId: params.runId,
      usage: params.tokenUsage,
      sourceUpdate: "run_paused",
    });
  }
  params.session.events.publish(
    params.sessionId,
    buildRunPausedEvent({
      runId: params.runId,
      procedure: params.procedure,
      result: params.result,
      tokenUsage: params.tokenUsage,
    }),
  );
  params.markRunActivity();
}

export function publishRunFailed(params: {
  session: SessionState;
  sessionId: string;
  runId: string;
  procedure: string;
  error: string;
  markRunActivity: () => void;
  run?: RunRef;
}): void {
  // Always emit an error procedure_panel alongside run_failed so the message
  // survives any tool-card filter state on the client.
  params.session.events.publish(params.sessionId, {
    type: "procedure_panel",
    runId: params.runId,
    procedure: params.procedure,
    panelId: `panel-${params.runId}-failed`,
    rendererId: "nb/error@1",
    payload: {
      procedure: params.procedure,
      message: params.error,
    },
    severity: "error",
    dismissible: false,
  });

  params.session.events.publish(params.sessionId, {
    type: "run_failed",
    runId: params.runId,
    procedure: params.procedure,
    completedAt: new Date().toISOString(),
    error: params.error,
    run: params.run,
  });
  params.markRunActivity();
}

export function publishRunCancelled(params: {
  session: SessionState;
  sessionId: string;
  runId: string;
  procedure: string;
  message: string;
  markRunActivity: () => void;
  run?: RunRef;
}): void {
  params.session.events.publish(
    params.sessionId,
    buildRunCancelledEvent({
      runId: params.runId,
      procedure: params.procedure,
      message: params.message,
      run: params.run,
    }),
  );
  params.markRunActivity();
}

function emitDisplayIfNeeded(
  emitter: CompositeSessionUpdateEmitter,
  display: string | undefined,
): void {
  if (!display || emitter.hasStreamedText(display)) {
    return;
  }

  emitter.emit({
    sessionUpdate: "agent_message_chunk",
    content: {
      type: "text",
      text: display,
    },
  });
}

function publishStoredMemoryCard(
  session: SessionState,
  sessionId: string,
  runId: string,
  runRef?: RunRef,
): void {
  if (!runRef) {
    return;
  }

  const storedMemoryCard = materializeProcedureMemoryCard(session.store, runRef);
  if (!storedMemoryCard) {
    return;
  }

  session.events.publish(sessionId, {
    type: "memory_card_stored",
    runId,
    card: storedMemoryCard,
  });
}
