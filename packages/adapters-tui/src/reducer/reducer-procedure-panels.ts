import type { RenderedFrontendEventEnvelope } from "@nanoboss/adapters-http";

import type {
  UiProcedurePanel,
  UiState,
} from "../state/state.ts";
import {
  markAssistantTextBoundary,
} from "./reducer-turns.ts";
import { appendTranscriptItem } from "./reducer-transcript-items.ts";
import {
  appendProcedurePanelBlockToActiveTurn,
  replaceProcedurePanelBlockInTurns,
} from "./reducer-procedure-panel-turns.ts";

export function applyProcedurePanel(
  state: UiState,
  data: Extract<RenderedFrontendEventEnvelope, { type: "procedure_panel" }>["data"],
): UiState {
  const existingByKey = data.key
    ? state.procedurePanels.find((p) =>
      p.key === data.key
        && p.rendererId === data.rendererId
        && p.runId === data.runId
    )
    : undefined;

  if (existingByKey) {
    // Replace in place, preserving ordering and transcript item.
    const updated: UiProcedurePanel = {
      ...existingByKey,
      rendererId: data.rendererId,
      payload: data.payload,
      severity: data.severity,
      dismissible: data.dismissible,
      procedure: data.procedure,
    };
    return {
      ...state,
      turns: replaceProcedurePanelBlockInTurns(state.turns, existingByKey.panelId, updated),
      procedurePanels: state.procedurePanels.map((p) =>
        p.panelId === existingByKey.panelId ? updated : p,
      ),
    };
  }

  const entry: UiProcedurePanel = {
    panelId: data.panelId,
    rendererId: data.rendererId,
    payload: data.payload,
    severity: data.severity,
    dismissible: data.dismissible,
    ...(data.key !== undefined ? { key: data.key } : {}),
    ...(data.runId ? { runId: data.runId } : {}),
    ...(state.activeAssistantTurnId ? { turnId: state.activeAssistantTurnId } : {}),
    procedure: data.procedure,
  };

  const nextState: UiState = {
    ...state,
    procedurePanels: [...state.procedurePanels, entry],
    transcriptItems: appendTranscriptItem(state.transcriptItems, {
      type: "procedure_panel",
      id: entry.panelId,
    }),
  };

  // Preserve ordering relative to text_delta and tool_call blocks using
  // the same boundary rule as tool calls.
  const withBlock = appendProcedurePanelBlockToActiveTurn(nextState, entry);
  return markAssistantTextBoundary(withBlock);
}
