import type {
  UiProcedurePanel,
  UiState,
} from "../state/state.ts";
import type { UiAction } from "./reducer-actions.ts";
import { appendTranscriptItem } from "./reducer-transcript-items.ts";
import { replaceProcedurePanelBlockInTurns } from "./reducer-procedure-panel-turns.ts";

type LocalProcedurePanelInput = Extract<UiAction, { type: "local_procedure_panel" }>;

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
