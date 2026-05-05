import type { UiState, UiTurn } from "../state/state.ts";

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
