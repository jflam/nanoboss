import type { UiState, UiTurn } from "./state.ts";
import {
  appendTranscriptItem,
} from "./reducer-turns.ts";
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

export function buildTurnCompletionNote(
  state: UiState,
  status: UiTurn["status"],
  completedAt: string | undefined,
): string | undefined {
  if (!status || status === "streaming" || state.runStartedAtMs === undefined) {
    return undefined;
  }

  const completedAtMs = completedAt ? Date.parse(completedAt) : Number.NaN;
  const finishedAtMs = Number.isFinite(completedAtMs) ? completedAtMs : Date.now();
  const durationMs = Math.max(0, finishedAtMs - state.runStartedAtMs);
  const attempted = state.activeRunAttemptedToolCallIds.length;
  const succeeded = state.activeRunSucceededToolCallIds.length;
  const turnNumber = getCompletionTurnNumber(state);
  const label = status === "complete"
    ? "completed"
    : status === "failed"
      ? "failed"
      : "stopped";

  return `turn #${turnNumber} ${label} in ${formatDuration(durationMs)} | tools ${succeeded}/${attempted} succeeded`;
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) {
    return `${durationMs}ms`;
  }

  return `${(durationMs / 1_000).toFixed(durationMs >= 10_000 ? 0 : 1)}s`;
}

function getCompletionTurnNumber(state: UiState): number {
  const activeAssistantTurnId = state.activeAssistantTurnId;
  if (!activeAssistantTurnId) {
    return Math.max(1, countUserTurns(state.turns));
  }

  const assistantIndex = state.turns.findIndex((turn) => turn.id === activeAssistantTurnId);
  if (assistantIndex < 0) {
    return Math.max(1, countUserTurns(state.turns));
  }

  return Math.max(1, countUserTurns(state.turns.slice(0, assistantIndex + 1)));
}

function countUserTurns(turns: UiTurn[]): number {
  return turns.filter((turn) => turn.role === "user").length;
}
