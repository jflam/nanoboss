import type { RenderedFrontendEventEnvelope } from "@nanoboss/adapters-http";

import type { NbCardV1Payload } from "../core/core-panels.ts";
import { getPanelRenderer } from "../core/panel-renderers.ts";
import type {
  UiPanel,
  UiState,
} from "../state/state.ts";
import {
  applyTranscriptCardPanel,
} from "./reducer-panel-cards.ts";

export {
  appendProcedureCard,
} from "./reducer-panel-cards.ts";

export function applyUiPanel(
  state: UiState,
  data: Extract<RenderedFrontendEventEnvelope, { type: "ui_panel" }>["data"],
): UiState {
  const renderer = getPanelRenderer(data.rendererId);
  if (!renderer) {
    return withDiagnosticStatus(
      state,
      `[panel] unknown renderer "${data.rendererId}"`,
    );
  }

  if (!renderer.schema.validate(data.payload)) {
    return withDiagnosticStatus(
      state,
      `[panel] invalid payload for "${data.rendererId}"`,
    );
  }

  if (data.rendererId === "nb/card@1" && data.slot === "transcript") {
    const payload = data.payload as NbCardV1Payload;
    return applyTranscriptCardPanel(state, data, payload);
  }

  const entry: UiPanel = {
    rendererId: data.rendererId,
    slot: data.slot,
    ...(data.key !== undefined ? { key: data.key } : {}),
    payload: data.payload,
    lifetime: data.lifetime,
    ...(data.runId ? { runId: data.runId } : {}),
    ...(state.activeAssistantTurnId ? { turnId: state.activeAssistantTurnId } : {}),
  };

  const remaining = state.panels.filter((existing) => !isSamePanelKey(existing, entry));
  return {
    ...state,
    panels: [...remaining, entry],
  };
}

function isSamePanelKey(a: UiPanel, b: UiPanel): boolean {
  return a.rendererId === b.rendererId && (a.key ?? undefined) === (b.key ?? undefined);
}

function withDiagnosticStatus(state: UiState, text: string): UiState {
  return {
    ...state,
    statusLine: text,
  };
}
