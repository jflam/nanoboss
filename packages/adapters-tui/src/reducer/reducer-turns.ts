import type {
  UiState,
} from "../state/state.ts";
import {
  appendTextToTurnBlocks,
  createAssistantTurn,
} from "./reducer-assistant-turn-text.ts";
import { appendTranscriptItem } from "./reducer-transcript-items.ts";

export function appendAssistantText(state: UiState, text: string): UiState {
  const activeAssistantTurnId = state.activeAssistantTurnId;
  const activeTurn = activeAssistantTurnId
    ? state.turns.find((turn) => turn.id === activeAssistantTurnId)
    : undefined;

  if (!activeTurn || state.assistantParagraphBreakPending) {
    const turns = activeTurn
      ? state.turns.map((turn) => turn.id === activeAssistantTurnId && turn.status === "streaming"
        ? { ...turn, status: "complete" as const }
        : turn)
      : state.turns;
    const assistantTurn = createAssistantTurn(state, text);

    return {
      ...state,
      turns: [...turns, assistantTurn],
      transcriptItems: appendTranscriptItem(state.transcriptItems, { type: "turn", id: assistantTurn.id }),
      activeAssistantTurnId: assistantTurn.id,
      assistantParagraphBreakPending: false,
    };
  }

  return {
    ...state,
    turns: state.turns.map((turn) => turn.id === activeAssistantTurnId
      ? appendTextToTurnBlocks({
          ...turn,
          markdown: `${turn.markdown}${text}`,
        }, text, "stream")
      : turn),
    assistantParagraphBreakPending: false,
  };
}

export function markAssistantTextBoundary(state: UiState): UiState {
  if (!state.activeAssistantTurnId) {
    return state;
  }

  const activeTurn = state.turns.find((turn) => turn.id === state.activeAssistantTurnId);
  if (!activeTurn?.markdown) {
    return state;
  }

  return {
    ...state,
    assistantParagraphBreakPending: true,
  };
}

export function appendToolCallBlockToActiveTurn(state: UiState, toolCallId: string): UiState {
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
      const alreadyPresent = blocks.some(
        (block) => block.kind === "tool_call" && block.toolCallId === toolCallId,
      );
      if (alreadyPresent) {
        return turn;
      }
      return {
        ...turn,
        blocks: [...blocks, { kind: "tool_call", toolCallId }],
      };
    }),
  };
}
