import type { UiState, UiTurn } from "../state/state.ts";
import {
  buildAssistantTurnMeta,
  createTurn,
  nextTurnId,
} from "./reducer-turn-factory.ts";

export function appendTextToTurnBlocks(
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

export function createAssistantTurn(state: UiState, markdown: string): UiTurn {
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
