import type { UiTurn } from "../state/state.ts";

export function buildAssistantTurnMeta(params: {
  existing?: UiTurn["meta"];
  procedure?: string;
  tokenUsageLine?: string;
  failureMessage?: string;
  completionNote?: string;
  statusMessage?: string;
}): UiTurn["meta"] | undefined {
  const statusMessage = params.statusMessage ?? params.existing?.statusMessage;
  const meta = {
    ...params.existing,
    procedure: params.procedure ?? params.existing?.procedure,
    tokenUsageLine: params.tokenUsageLine ?? params.existing?.tokenUsageLine,
    failureMessage: params.failureMessage,
    completionNote: params.completionNote ?? params.existing?.completionNote,
    ...(statusMessage !== undefined ? { statusMessage } : {}),
  };

  return meta.procedure || meta.tokenUsageLine || meta.failureMessage || meta.completionNote || statusMessage
    ? meta
    : undefined;
}

export function createTurn(turn: UiTurn): UiTurn {
  return turn;
}

export function nextTurnId(role: UiTurn["role"], index: number): string {
  return `${role}-${index + 1}`;
}
