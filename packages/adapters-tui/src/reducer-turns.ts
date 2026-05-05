import type {
  UiState,
  UiTranscriptItem,
  UiTurn,
} from "./state.ts";
import {
  buildAssistantTurnMeta,
  createTurn,
  nextTurnId,
} from "./reducer-turn-factory.ts";

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

function appendTextToTurnBlocks(
  turn: UiTurn,
  text: string,
  origin: "stream" | "replay",
): UiTurn {
  if (text.length === 0) {
    return turn;
  }
  const blocks = turn.blocks ?? [];
  const last = blocks[blocks.length - 1];
  if (last && last.kind === "text" && last.origin === origin) {
    const nextBlocks = blocks.slice(0, -1);
    nextBlocks.push({ kind: "text", text: `${last.text}${text}`, origin });
    return { ...turn, blocks: nextBlocks };
  }
  return { ...turn, blocks: [...blocks, { kind: "text", text, origin }] };
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

export function appendTranscriptItem(items: UiTranscriptItem[], nextItem: UiTranscriptItem): UiTranscriptItem[] {
  const exists = items.some((item) => item.type === nextItem.type && item.id === nextItem.id);
  return exists ? items : [...items, nextItem];
}

export function removeTranscriptItem(
  items: UiTranscriptItem[],
  type: UiTranscriptItem["type"],
  id: string,
): UiTranscriptItem[] {
  return items.filter((item) => !(item.type === type && item.id === id));
}

function createAssistantTurn(state: UiState, markdown: string): UiTurn {
  return createTurn({
    id: nextTurnId("assistant", state.turns.length),
    role: "assistant",
    markdown,
    blocks: markdown.length > 0
      ? [{ kind: "text", text: markdown, origin: "stream" }]
      : [],
    status: "streaming",
    runId: state.activeRunId,
    meta: buildAssistantTurnMeta({
      procedure: state.activeProcedure,
    }),
  });
}
