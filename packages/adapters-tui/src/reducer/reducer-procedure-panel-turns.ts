import type {
  UiProcedurePanel,
  UiState,
  UiTurn,
} from "../state/state.ts";

export function appendProcedurePanelBlockToActiveTurn(
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

export function replaceProcedurePanelBlockInTurns(
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
