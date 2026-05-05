import type { RenderedFrontendEventEnvelope } from "@nanoboss/adapters-http";
import type { ProcedureUiEvent } from "@nanoboss/procedure-engine";

import {
  nbCardV1Tone,
  renderNbCardV1Markdown,
  type NbCardV1Payload,
} from "./core-panels.ts";
import { getPanelRenderer } from "./panel-renderers.ts";
import type {
  UiPanel,
  UiProcedurePanel,
  UiState,
  UiTurn,
} from "./state.ts";
import {
  appendTranscriptItem,
  buildAssistantTurnMeta,
  createTurn,
  markAssistantTextBoundary,
  nextTurnId,
} from "./reducer-turns.ts";

interface LocalProcedurePanelInput {
  panelId: string;
  rendererId: string;
  payload: unknown;
  severity: "info" | "warn" | "error";
  dismissible: boolean;
  key?: string;
  procedure?: string;
}

export function applyLocalProcedurePanel(
  state: UiState,
  action: LocalProcedurePanelInput,
): UiState {
  const existingByKey = action.key
    ? state.procedurePanels.find((p) =>
      p.key === action.key
        && p.rendererId === action.rendererId
        && p.runId === undefined
    )
    : undefined;

  if (existingByKey) {
    const updated: UiProcedurePanel = {
      ...existingByKey,
      rendererId: action.rendererId,
      payload: action.payload,
      severity: action.severity,
      dismissible: action.dismissible,
      procedure: action.procedure,
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
    panelId: action.panelId,
    rendererId: action.rendererId,
    payload: action.payload,
    severity: action.severity,
    dismissible: action.dismissible,
    ...(action.key !== undefined ? { key: action.key } : {}),
    ...(action.procedure !== undefined ? { procedure: action.procedure } : {}),
  };

  return {
    ...state,
    procedurePanels: [...state.procedurePanels, entry],
    transcriptItems: appendTranscriptItem(state.transcriptItems, {
      type: "procedure_panel",
      id: entry.panelId,
    }),
  };
}

export function appendProcedureCard(
  state: UiState,
  card: Extract<RenderedFrontendEventEnvelope, { type: "procedure_card" }>["data"],
): UiState {
  const turns = state.activeAssistantTurnId
    ? state.turns.map((turn) => turn.id === state.activeAssistantTurnId && turn.status === "streaming"
      ? { ...turn, status: "complete" as const }
      : turn)
    : state.turns;
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
    const turns = state.activeAssistantTurnId
      ? state.turns.map((turn) => turn.id === state.activeAssistantTurnId && turn.status === "streaming"
        ? { ...turn, status: "complete" as const }
        : turn)
      : state.turns;
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

function appendProcedurePanelBlockToActiveTurn(
  state: UiState,
  panel: UiProcedurePanel,
): UiState {
  const activeId = state.activeAssistantTurnId;
  if (!activeId) {
    return state;
  }
  return {
    ...state,
    turns: state.turns.map((turn) => {
      if (turn.id !== activeId) {
        return turn;
      }
      const blocks = turn.blocks ?? [];
      return {
        ...turn,
        blocks: [
          ...blocks,
          {
            kind: "procedure_panel" as const,
            panelId: panel.panelId,
            rendererId: panel.rendererId,
            payload: panel.payload,
            severity: panel.severity,
            dismissible: panel.dismissible,
            ...(panel.key !== undefined ? { key: panel.key } : {}),
          },
        ],
      };
    }),
  };
}

function replaceProcedurePanelBlockInTurns(
  turns: UiTurn[],
  panelId: string,
  panel: UiProcedurePanel,
): UiTurn[] {
  return turns.map((turn) => {
    if (!turn.blocks?.some((block) => block.kind === "procedure_panel" && block.panelId === panelId)) {
      return turn;
    }
    return {
      ...turn,
      blocks: turn.blocks.map((block) =>
        block.kind === "procedure_panel" && block.panelId === panelId
          ? {
              kind: "procedure_panel" as const,
              panelId,
              rendererId: panel.rendererId,
              payload: panel.payload,
              severity: panel.severity,
              dismissible: panel.dismissible,
              ...(panel.key !== undefined ? { key: panel.key } : {}),
            }
          : block
      ),
    };
  });
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
