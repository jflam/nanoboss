import type { UiState, UiTurn } from "../state/state.ts";
import { appendTranscriptItem } from "./reducer-transcript-items.ts";
import {
  buildAssistantTurnMeta,
  createTurn,
  nextTurnId,
} from "./reducer-turn-factory.ts";

export function finalizeAssistantTurn(
  state: UiState,
  params: {
    status: UiTurn["status"];
    completionText?: string;
    tokenUsageLine?: string;
    failureMessage?: string;
    statusMessage?: string;
    completionNote?: string;
  },
): UiState {
  const activeAssistantTurnId = state.activeAssistantTurnId;
  if (!activeAssistantTurnId) {
    if (!params.completionText) {
      return state;
    }

    const turn = createTurn({
      id: nextTurnId("assistant", state.turns.length),
      role: "assistant",
      markdown: params.completionText,
      blocks: [{ kind: "text", text: params.completionText, origin: "replay" }],
      status: params.status,
      runId: state.activeRunId,
      displayStyle: params.status === "complete" ? "inline" : "card",
      cardTone: params.status === "failed"
        ? "error"
        : params.status === "cancelled"
          ? "warning"
          : "info",
      meta: buildAssistantTurnMeta({
        procedure: state.activeProcedure,
        tokenUsageLine: params.tokenUsageLine,
        failureMessage: undefined,
        statusMessage: undefined,
        completionNote: params.completionNote,
      }),
    });

    return {
      ...state,
      turns: [...state.turns, turn],
      transcriptItems: appendTranscriptItem(state.transcriptItems, { type: "turn", id: turn.id }),
    };
  }

  return {
    ...state,
    turns: state.turns.map((turn) => {
      if (turn.id !== activeAssistantTurnId) {
        return turn;
      }

      const hadStreamedText = turn.markdown.length > 0;
      const markdown = hadStreamedText ? turn.markdown : (params.completionText ?? turn.markdown);
      const blocks = hadStreamedText
        ? turn.blocks
        : params.completionText !== undefined
          ? [{ kind: "text" as const, text: params.completionText, origin: "replay" as const }]
          : turn.blocks;
      return {
        ...turn,
        markdown,
        blocks,
        status: params.status,
        displayStyle: !hadStreamedText && params.status !== "complete" ? "card" : turn.displayStyle,
        cardTone: !hadStreamedText && params.status !== "complete"
          ? params.status === "failed"
            ? "error"
            : params.status === "cancelled"
              ? "warning"
              : "info"
          : turn.cardTone,
        meta: buildAssistantTurnMeta({
          existing: turn.meta,
          procedure: turn.meta?.procedure ?? state.activeProcedure,
          tokenUsageLine: params.tokenUsageLine,
          failureMessage: hadStreamedText ? params.failureMessage : undefined,
          statusMessage: hadStreamedText ? params.statusMessage : undefined,
          completionNote: params.completionNote,
        }),
      };
    }),
  };
}
