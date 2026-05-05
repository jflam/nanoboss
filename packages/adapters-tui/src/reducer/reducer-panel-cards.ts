import type { RenderedFrontendEventEnvelope } from "@nanoboss/adapters-http";
import type { ProcedureUiEvent } from "@nanoboss/procedure-engine";

import {
  nbCardV1Tone,
  renderNbCardV1Markdown,
  type NbCardV1Payload,
} from "../core/core-panels.ts";
import type {
  UiState,
  UiTurn,
} from "../state/state.ts";
import { appendTranscriptItem } from "./reducer-transcript-items.ts";
import {
  buildAssistantTurnMeta,
  createTurn,
  nextTurnId,
} from "./reducer-turn-factory.ts";

export function appendProcedureCard(
  state: UiState,
  card: Extract<RenderedFrontendEventEnvelope, { type: "procedure_card" }>["data"],
): UiState {
  const turns = completeActiveAssistantTurn(state);
  const turn = createTurn({
    id: nextTurnId("assistant", turns.length),
    role: "assistant",
    markdown: renderProcedureCardMarkdown(card.card),
    status: "complete",
    runId: card.runId,
    displayStyle: "card",
    cardTone: procedureCardTone(card.card.kind),
    meta: buildAssistantTurnMeta({
      procedure: card.card.procedure,
    }),
  });

  return {
    ...state,
    turns: [...turns, turn],
    transcriptItems: appendTranscriptItem(state.transcriptItems, { type: "turn", id: turn.id }),
    activeAssistantTurnId: undefined,
    assistantParagraphBreakPending: false,
  };
}

export function applyTranscriptCardPanel(
  state: UiState,
  data: Extract<RenderedFrontendEventEnvelope, { type: "ui_panel" }>["data"],
  payload: NbCardV1Payload,
): UiState {
  const turns = completeActiveAssistantTurn(state);
  const turn = createTurn({
    id: nextTurnId("assistant", turns.length),
    role: "assistant",
    markdown: renderNbCardV1Markdown(payload),
    status: "complete",
    runId: data.runId,
    displayStyle: "card",
    cardTone: nbCardV1Tone(payload.kind),
    meta: buildAssistantTurnMeta({
      procedure: data.procedure,
    }),
  });

  return {
    ...state,
    turns: [...turns, turn],
    transcriptItems: appendTranscriptItem(state.transcriptItems, { type: "turn", id: turn.id }),
    activeAssistantTurnId: undefined,
    assistantParagraphBreakPending: false,
  };
}

function completeActiveAssistantTurn(state: UiState): UiTurn[] {
  return state.activeAssistantTurnId
    ? state.turns.map((turn) => turn.id === state.activeAssistantTurnId && turn.status === "streaming"
      ? { ...turn, status: "complete" as const }
      : turn)
    : state.turns;
}

function renderProcedureCardMarkdown(card: Extract<ProcedureUiEvent, { type: "card" }>): string {
  return [
    `## ${card.title}`,
    "",
    `_${card.kind}_`,
    "",
    card.markdown.trim(),
  ].filter((line, index, lines) => line.length > 0 || index < lines.length - 1).join("\n");
}

function procedureCardTone(kind: Extract<ProcedureUiEvent, { type: "card" }>["kind"]): NonNullable<UiTurn["cardTone"]> {
  switch (kind) {
    case "summary":
      return "success";
    case "checkpoint":
      return "warning";
    default:
      return "info";
  }
}
