import type { RenderedFrontendEventEnvelope } from "@nanoboss/adapters-http";

import type {
  UiProcedurePanel,
  UiState,
  UiTurn,
} from "./state.ts";
import {
  appendTranscriptItem,
  markAssistantTextBoundary,
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
