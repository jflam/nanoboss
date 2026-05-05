import type { RenderedFrontendEventEnvelope } from "@nanoboss/adapters-http";

import type {
  UiState,
  UiTranscriptItem,
  UiTurn,
} from "../state/state.ts";
import { appendTranscriptItem } from "./reducer-transcript-items.ts";
import {
  buildAssistantTurnMeta,
  createTurn,
  nextTurnId,
} from "./reducer-turn-factory.ts";

type RunRestoredEvent = Extract<RenderedFrontendEventEnvelope, { type: "run_restored" }>;

export function reduceRunRestoredEvent(
  state: UiState,
  event: RunRestoredEvent,
): UiState {
  const pendingContinuation = event.data.status === "paused"
    ? {
        procedure: event.data.procedure,
        question: "",
      }
    : state.pendingContinuation;
  const userTurn = createTurn({
    id: nextTurnId("user", state.turns.length),
    role: "user",
    markdown: event.data.prompt,
    status: "complete",
  });
  const nextTurns: UiTurn[] = [...state.turns, userTurn];
  const nextTranscriptItems: UiTranscriptItem[] = appendTranscriptItem(
    state.transcriptItems,
    { type: "turn", id: userTurn.id },
  );
  if (!event.data.text) {
    return {
      ...state,
      turns: nextTurns,
      transcriptItems: nextTranscriptItems,
      activeRunId: event.data.runId,
      activeProcedure: event.data.procedure,
      activeAssistantTurnId: undefined,
      assistantParagraphBreakPending: undefined,
      pendingContinuation,
    };
  }

  const assistantTurn = createTurn({
    id: nextTurnId("assistant", nextTurns.length),
    role: "assistant",
    markdown: event.data.text,
    blocks: event.data.text.length > 0
      ? [{ kind: "text", text: event.data.text, origin: "replay" }]
      : [],
    status: event.data.status === "paused" ? "complete" : event.data.status,
    runId: event.data.runId,
    meta: buildAssistantTurnMeta({
      procedure: event.data.procedure,
    }),
  });

  return {
    ...state,
    turns: [...nextTurns, assistantTurn],
    transcriptItems: appendTranscriptItem(nextTranscriptItems, { type: "turn", id: assistantTurn.id }),
    pendingContinuation,
  };
}
