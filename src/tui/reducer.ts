import type { ProcedureUiEvent } from "../core/context-shared.ts";
import {
  type FrontendCommand,
  type RenderedFrontendEventEnvelope,
} from "../http/frontend-events.ts";
import type { DownstreamAgentSelection } from "../core/types.ts";
import { formatProcedureStatusText } from "../core/ui-cli.ts";
import type { ToolCardThemeMode } from "./state.ts";

import { formatTokenUsageLine } from "./format.ts";
import { LOCAL_TUI_COMMANDS } from "./commands.ts";
import {
  createInitialUiState,
  type UiPendingPrompt,
  type UiState,
  type UiToolCall,
  type UiTranscriptItem,
  type UiTurn,
} from "./state.ts";

const STOP_REQUESTED_STATUS = "[run] ESC received - stopping at next tool boundary...";

export type UiAction =
  | {
      type: "session_ready";
      sessionId: string;
      cwd: string;
      buildLabel: string;
      agentLabel: string;
      commands: FrontendCommand[];
      defaultAgentSelection?: DownstreamAgentSelection;
    }
  | {
      type: "local_user_submitted";
      text: string;
    }
  | {
      type: "local_send_failed";
      error: string;
    }
  | {
      type: "local_status";
      text?: string;
    }
  | {
      type: "local_stop_requested";
      runId?: string;
    }
  | {
      type: "local_stop_request_failed";
      runId?: string;
      text: string;
    }
  | {
      type: "local_pending_prompt_added";
      prompt: UiPendingPrompt;
    }
  | {
      type: "local_pending_prompt_removed";
      promptId: string;
    }
  | {
      type: "local_pending_prompts_cleared";
      text: string;
    }
  | {
      type: "local_agent_selection";
      agentLabel: string;
      selection: DownstreamAgentSelection;
    }
  | {
      type: "local_tool_card_theme_mode";
      mode: ToolCardThemeMode;
    }
  | {
      type: "local_simplify2_auto_approve";
      enabled: boolean;
    }
  | {
      type: "toggle_tool_output";
    }
  | {
      type: "frontend_event";
      event: RenderedFrontendEventEnvelope;
    };

export function reduceUiState(state: UiState, action: UiAction): UiState {
  switch (action.type) {
    case "session_ready":
      return {
        ...createInitialUiState({
          cwd: action.cwd,
          buildLabel: action.buildLabel,
          agentLabel: action.agentLabel,
          showToolCalls: state.showToolCalls,
          expandedToolOutput: state.expandedToolOutput,
          toolCardThemeMode: state.toolCardThemeMode,
          simplify2AutoApprove: state.simplify2AutoApprove,
        }),
        sessionId: action.sessionId,
        buildLabel: action.buildLabel,
        agentLabel: action.agentLabel,
        defaultAgentSelection: action.defaultAgentSelection,
        availableCommands: mergeAvailableCommands(action.commands),
      };
    case "local_user_submitted": {
      const nextTurn = createTurn({
        id: nextTurnId("user", state.turns.length),
        role: "user",
        markdown: action.text,
        status: "complete",
      });

      return {
        ...state,
        turns: [...state.turns, nextTurn],
        transcriptItems: appendTranscriptItem(state.transcriptItems, { type: "turn", id: nextTurn.id }),
        activeRunId: undefined,
        activeProcedure: undefined,
        activeAssistantTurnId: undefined,
        assistantParagraphBreakPending: undefined,
        runStartedAtMs: Date.now(),
        activeRunAttemptedToolCallIds: [],
        activeRunSucceededToolCallIds: [],
        pendingStopRequest: false,
        stopRequestedRunId: undefined,
        statusLine: "[run] waiting for response",
        inputDisabled: true,
      };
    }
    case "local_send_failed": {
      const nextTurn = createTurn({
        id: nextTurnId("system", state.turns.length),
        role: "system",
        markdown: action.error,
        status: "failed",
        displayStyle: "card",
        cardTone: "error",
      });

      return {
        ...state,
        turns: [...state.turns, nextTurn],
        transcriptItems: appendTranscriptItem(state.transcriptItems, { type: "turn", id: nextTurn.id }),
        activeRunId: undefined,
        activeProcedure: undefined,
        activeAssistantTurnId: undefined,
        assistantParagraphBreakPending: undefined,
        runStartedAtMs: undefined,
        activeRunAttemptedToolCallIds: [],
        activeRunSucceededToolCallIds: [],
        pendingStopRequest: false,
        stopRequestedRunId: undefined,
        statusLine: `[run] ${action.error}`,
        inputDisabled: false,
      };
    }
    case "local_status":
      return {
        ...state,
        statusLine: action.text,
      };
    case "local_stop_requested":
      return {
        ...state,
        pendingStopRequest: !action.runId,
        stopRequestedRunId: action.runId,
        statusLine: STOP_REQUESTED_STATUS,
      };
    case "local_stop_request_failed":
      if (action.runId) {
        if (state.stopRequestedRunId !== action.runId) {
          return state;
        }
      } else if (!state.pendingStopRequest) {
        return state;
      }

      return {
        ...state,
        pendingStopRequest: false,
        stopRequestedRunId: undefined,
        statusLine: action.text,
      };
    case "local_pending_prompt_added":
      return {
        ...state,
        pendingPrompts: [...state.pendingPrompts, action.prompt],
      };
    case "local_pending_prompt_removed":
      return {
        ...state,
        pendingPrompts: state.pendingPrompts.filter((prompt) => prompt.id !== action.promptId),
      };
    case "local_pending_prompts_cleared":
      return {
        ...state,
        pendingPrompts: [],
        statusLine: action.text,
      };
    case "local_agent_selection":
      return {
        ...state,
        agentLabel: action.agentLabel,
        defaultAgentSelection: action.selection,
      };
    case "local_tool_card_theme_mode":
      return {
        ...state,
        toolCardThemeMode: action.mode,
        statusLine: `[theme] tool cards ${action.mode}`,
      };
    case "local_simplify2_auto_approve":
      return {
        ...state,
        simplify2AutoApprove: action.enabled,
        statusLine: `[simplify2] auto-approve ${action.enabled ? "on" : "off"}`,
      };
    case "toggle_tool_output":
      return {
        ...state,
        expandedToolOutput: !state.expandedToolOutput,
      };
    case "frontend_event":
      return reduceFrontendEvent(state, action.event);
  }
}

function reduceFrontendEvent(state: UiState, event: RenderedFrontendEventEnvelope): UiState {
  switch (event.type) {
    case "commands_updated":
      return {
        ...state,
        availableCommands: mergeAvailableCommands(event.data.commands),
      };
    case "run_restored": {
      const pendingProcedureContinuation = event.data.status === "paused"
        ? {
            procedure: event.data.procedure,
            question: "",
          }
        : state.pendingProcedureContinuation;
      const userTurn = createTurn({
        id: nextTurnId("user", state.turns.length),
        role: "user",
        markdown: event.data.prompt,
        status: "complete",
      });
      const nextTurns: UiTurn[] = [...state.turns, userTurn];
      const nextTranscriptItems: UiTranscriptItem[] = appendTranscriptItem(
        state.transcriptItems,
        { type: "turn", id: userTurn.id },
      );
      if (!event.data.text) {
        return {
          ...state,
          turns: nextTurns,
          transcriptItems: nextTranscriptItems,
          activeRunId: event.data.runId,
          activeProcedure: event.data.procedure,
          activeAssistantTurnId: undefined,
          assistantParagraphBreakPending: undefined,
          pendingProcedureContinuation,
        };
      }

      const assistantTurn = createTurn({
        id: nextTurnId("assistant", nextTurns.length),
        role: "assistant",
        markdown: event.data.text,
        status: event.data.status === "paused" ? "complete" : event.data.status,
        runId: event.data.runId,
        meta: buildAssistantTurnMeta({
          procedure: event.data.procedure,
        }),
      });

      return {
        ...state,
        turns: [...nextTurns, assistantTurn],
        transcriptItems: appendTranscriptItem(nextTranscriptItems, { type: "turn", id: assistantTurn.id }),
        pendingProcedureContinuation,
      };
    }
    case "run_started": {
      const stopRequestedRunId = state.pendingStopRequest || state.stopRequestedRunId === event.data.runId
        ? event.data.runId
        : undefined;
      const parsedStartedAtMs = Date.parse(event.data.startedAt);
      const runStartedAtMs = Number.isFinite(parsedStartedAtMs)
        ? state.runStartedAtMs !== undefined
          ? Math.min(state.runStartedAtMs, parsedStartedAtMs)
          : parsedStartedAtMs
        : state.runStartedAtMs ?? Date.now();
      return {
        ...state,
        activeRunId: event.data.runId,
        activeProcedure: event.data.procedure,
        activeAssistantTurnId: undefined,
        assistantParagraphBreakPending: undefined,
        runStartedAtMs,
        activeRunAttemptedToolCallIds: [],
        activeRunSucceededToolCallIds: [],
        pendingStopRequest: false,
        stopRequestedRunId,
        statusLine: stopRequestedRunId ? STOP_REQUESTED_STATUS : `[run] invoking /${event.data.procedure}…`,
        inputDisabled: true,
      };
    }
    case "continuation_updated":
      return {
        ...state,
        pendingProcedureContinuation: event.data.continuation,
      };
    case "assistant_notice":
      if (shouldIgnoreMismatchedRunEvent(state, event.data.runId)) {
        return state;
      }
      return appendAssistantNoticeCard(state, event.data.text, event.data.tone);
    case "procedure_status":
      if (shouldIgnoreMismatchedRunEvent(state, event.data.runId)) {
        return state;
      }
      return {
        ...state,
        statusLine: formatProcedureStatusText(event.data.status),
      };
    case "procedure_card":
      if (shouldIgnoreMismatchedRunEvent(state, event.data.runId)) {
        return state;
      }
      return appendProcedureCard(state, event.data);
    case "text_delta":
      if (shouldIgnoreMismatchedRunEvent(state, event.data.runId)) {
        return state;
      }
      return appendAssistantText(state, event.data.text);
    case "token_usage":
      if (shouldIgnoreMismatchedRunEvent(state, event.data.runId)) {
        return state;
      }
      return {
        ...state,
        tokenUsageLine: formatTokenUsageLine(event.data.usage),
      };
    case "run_heartbeat": {
      if (shouldIgnoreMismatchedRunEvent(state, event.data.runId)) {
        return state;
      }
      if (isStopRequestedForRun(state, event.data.runId)) {
        return state;
      }

      const now = Date.parse(event.data.at) || Date.now();
      const startedAt = state.runStartedAtMs ?? now;
      const elapsedSeconds = Math.max(1, Math.round((now - startedAt) / 1_000));
      return {
        ...state,
        statusLine: `[run] /${event.data.procedure} still working (${elapsedSeconds}s)`,
      };
    }
    case "tool_started": {
      if (shouldIgnoreMismatchedRunEvent(state, event.data.runId)) {
        return state;
      }
      const existing = state.toolCalls.find((toolCall) => toolCall.id === event.data.toolCallId);
      const parentToolCallId = event.data.parentToolCallId ?? existing?.parentToolCallId;
      const transcriptVisible = event.data.transcriptVisible ?? existing?.transcriptVisible ?? true;
      const removeOnTerminal = event.data.removeOnTerminal ?? existing?.removeOnTerminal ?? false;
      const toolName = existing?.toolName ?? event.data.toolName;
      const activeRunAttemptedToolCallIds = state.activeRunId === event.data.runId
        ? appendUniqueString(state.activeRunAttemptedToolCallIds, event.data.toolCallId)
        : state.activeRunAttemptedToolCallIds;

      if (!state.showToolCalls) {
        return {
          ...state,
          activeRunAttemptedToolCallIds,
        };
      }

      const nextToolCall: UiToolCall = {
        id: event.data.toolCallId,
        runId: event.data.runId,
        ...(parentToolCallId ? { parentToolCallId } : {}),
        ...(transcriptVisible === false ? { transcriptVisible } : {}),
        ...(removeOnTerminal ? { removeOnTerminal } : {}),
        title: event.data.title,
        kind: event.data.kind,
        toolName,
        status: event.data.status ?? existing?.status ?? "pending",
        depth: existing?.depth ?? 0,
        isWrapper: existing?.isWrapper ?? event.data.kind === "wrapper",
        callPreview: mergeToolPreview(existing?.callPreview, event.data.callPreview),
        resultPreview: existing?.resultPreview,
        errorPreview: existing?.errorPreview,
        rawInput: event.data.rawInput ?? existing?.rawInput,
        rawOutput: existing?.rawOutput,
        durationMs: existing?.durationMs,
      };

      const nextState = {
        ...state,
        toolCalls: recomputeToolCallDepths(upsertToolCall(state.toolCalls, nextToolCall)),
        transcriptItems: !transcriptVisible
          ? state.transcriptItems
          : appendTranscriptItem(state.transcriptItems, { type: "tool_call", id: nextToolCall.id }),
        activeRunAttemptedToolCallIds,
      };
      return existing || !transcriptVisible ? nextState : markAssistantTextBoundary(nextState);
    }
    case "tool_updated": {
      const existing = state.toolCalls.find((toolCall) => toolCall.id === event.data.toolCallId);
      const title = event.data.title ?? existing?.title ?? event.data.toolCallId;
      const parentToolCallId = event.data.parentToolCallId ?? existing?.parentToolCallId;
      const transcriptVisible = event.data.transcriptVisible ?? existing?.transcriptVisible ?? true;
      const removeOnTerminal = event.data.removeOnTerminal ?? existing?.removeOnTerminal ?? false;
      const toolName = existing?.toolName ?? event.data.toolName;
      const activeRunSucceededToolCallIds = state.activeRunId === event.data.runId && event.data.status === "completed"
        ? appendUniqueString(state.activeRunSucceededToolCallIds, event.data.toolCallId)
        : state.activeRunSucceededToolCallIds;

      if (!state.showToolCalls) {
        return {
          ...state,
          activeRunSucceededToolCallIds,
        };
      }

      const nextToolCall: UiToolCall = {
        id: event.data.toolCallId,
        runId: event.data.runId,
        ...(parentToolCallId ? { parentToolCallId } : {}),
        ...(transcriptVisible === false ? { transcriptVisible } : {}),
        ...(removeOnTerminal ? { removeOnTerminal } : {}),
        title,
        kind: existing?.kind ?? "other",
        toolName,
        status: event.data.status,
        depth: existing?.depth ?? 0,
        isWrapper: existing?.isWrapper ?? existing?.kind === "wrapper",
        callPreview: existing?.callPreview,
        resultPreview: mergeToolPreview(existing?.resultPreview, event.data.resultPreview),
        errorPreview: mergeToolPreview(existing?.errorPreview, event.data.errorPreview),
        rawInput: existing?.rawInput,
        rawOutput: event.data.rawOutput ?? existing?.rawOutput,
        durationMs: event.data.durationMs ?? existing?.durationMs,
      };

      let toolCalls = state.toolCalls;
      let transcriptItems = state.transcriptItems;
      const shouldRemoveTerminalToolCall = removeOnTerminal && isTerminalToolStatus(event.data.status);

      if (shouldRemoveTerminalToolCall) {
        toolCalls = removeToolCallAndReparent(toolCalls, event.data.toolCallId);
        transcriptItems = removeTranscriptItem(transcriptItems, "tool_call", event.data.toolCallId);
      } else {
        toolCalls = recomputeToolCallDepths(upsertToolCall(toolCalls, nextToolCall));
        transcriptItems = !transcriptVisible
          ? transcriptItems
          : appendTranscriptItem(transcriptItems, { type: "tool_call", id: nextToolCall.id });
      }

      const nextState = {
        ...state,
        toolCalls,
        transcriptItems,
        activeRunSucceededToolCallIds,
      };
      return existing || !transcriptVisible || shouldRemoveTerminalToolCall
        ? nextState
        : markAssistantTextBoundary(nextState);
    }
    case "run_completed": {
      if (shouldIgnoreMismatchedRunEvent(state, event.data.runId)) {
        return state;
      }
      const tokenUsageLine = event.data.tokenUsage ? formatTokenUsageLine(event.data.tokenUsage) : state.tokenUsageLine;
      const statusLine = event.data.procedure === "dismiss"
        ? buildDismissContinuationStatusLine(event.data.display)
        : `[run] ${event.data.procedure} completed`;
      return finishRun(state, {
        turnStatus: "complete",
        fallbackText: event.data.display,
        tokenUsageLine,
        completedAt: event.data.completedAt,
        statusLine,
      });
    }
    case "run_paused": {
      if (shouldIgnoreMismatchedRunEvent(state, event.data.runId)) {
        return state;
      }
      const tokenUsageLine = event.data.tokenUsage ? formatTokenUsageLine(event.data.tokenUsage) : state.tokenUsageLine;
      const nextState = finishRun(state, {
        turnStatus: "complete",
        fallbackText: event.data.display ?? event.data.question,
        tokenUsageLine,
        completedAt: event.data.pausedAt,
        statusLine: buildContinuationStatusLine(event.data.procedure),
      });
      return {
        ...nextState,
        pendingProcedureContinuation: {
          procedure: event.data.procedure,
          question: event.data.question,
          inputHint: event.data.inputHint,
          suggestedReplies: event.data.suggestedReplies,
          continuationUi: event.data.continuationUi,
        },
      };
    }
    case "run_failed":
      if (shouldIgnoreMismatchedRunEvent(state, event.data.runId)) {
        return state;
      }
      return finishRun(state, {
        turnStatus: "failed",
        fallbackText: event.data.error,
        failureMessage: event.data.error,
        completedAt: event.data.completedAt,
        statusLine: `[run] ${event.data.error}`,
      });
    case "run_cancelled":
      if (shouldIgnoreMismatchedRunEvent(state, event.data.runId)) {
        return state;
      }
      return finishRun(state, {
        turnStatus: "cancelled",
        fallbackText: event.data.message,
        statusMessage: event.data.message,
        completedAt: event.data.completedAt,
        statusLine: `[run] ${event.data.procedure} stopped`,
      });
  }
}

function mergeAvailableCommands(commands: FrontendCommand[]): string[] {
  return uniqueStrings([
    ...commands.map((command) => `/${command.name}`),
    ...LOCAL_TUI_COMMANDS.map((command) => command.name),
  ]);
}

function shouldIgnoreMismatchedRunEvent(state: UiState, runId: string): boolean {
  return state.activeRunId !== undefined && state.activeRunId !== runId;
}

function appendAssistantText(state: UiState, text: string): UiState {
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
      ? {
          ...turn,
          markdown: `${turn.markdown}${text}`,
        }
      : turn),
    assistantParagraphBreakPending: false,
  };
}

function appendAssistantNoticeCard(
  state: UiState,
  text: string,
  tone: "info" | "warning" | "error",
): UiState {
  const turns = state.activeAssistantTurnId
    ? state.turns.map((turn) => turn.id === state.activeAssistantTurnId && turn.status === "streaming"
      ? { ...turn, status: "complete" as const }
      : turn)
    : state.turns;
  const turn = createTurn({
    id: nextTurnId("assistant", turns.length),
    role: "assistant",
    markdown: text,
    status: tone === "error" ? "failed" : "complete",
    runId: state.activeRunId,
    displayStyle: "card",
    cardTone: tone,
    meta: buildAssistantTurnMeta({
      procedure: state.activeProcedure,
    }),
  });

  return {
    ...state,
    turns: [...turns, turn],
    transcriptItems: appendTranscriptItem(state.transcriptItems, { type: "turn", id: turn.id }),
    activeAssistantTurnId: undefined,
    assistantParagraphBreakPending: false,
  };
}

function markAssistantTextBoundary(state: UiState): UiState {
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

function buildContinuationStatusLine(procedure: string): string {
  return `[continuation] /${procedure} active - waiting for your reply`;
}

function buildDismissContinuationStatusLine(display?: string): string {
  const clearedMatch = display?.match(/\/([A-Za-z0-9/_-]+)/);
  return clearedMatch
    ? `[continuation] cleared /${clearedMatch[1]}`
    : "[continuation] nothing to clear";
}

function finishRun(
  state: UiState,
  params: {
    turnStatus: UiTurn["status"];
    fallbackText?: string;
    tokenUsageLine?: string;
    failureMessage?: string;
    statusMessage?: string;
    completedAt?: string;
    statusLine: string;
  },
): UiState {
  const completionNote = buildTurnCompletionNote(state, params.turnStatus, params.completedAt);
  const nextState = finalizeAssistantTurn(state, {
    status: params.turnStatus,
      fallbackText: params.fallbackText,
      tokenUsageLine: params.tokenUsageLine,
      failureMessage: params.failureMessage,
      statusMessage: params.statusMessage,
      completionNote,
    });

  return {
    ...nextState,
    activeRunId: undefined,
    activeProcedure: undefined,
    activeAssistantTurnId: undefined,
    assistantParagraphBreakPending: undefined,
    runStartedAtMs: undefined,
    activeRunAttemptedToolCallIds: [],
    activeRunSucceededToolCallIds: [],
    pendingStopRequest: false,
    stopRequestedRunId: undefined,
    tokenUsageLine: params.tokenUsageLine ?? nextState.tokenUsageLine,
    statusLine: params.statusLine,
    inputDisabled: false,
  };
}

function finalizeAssistantTurn(
  state: UiState,
  params: {
    status: UiTurn["status"];
    fallbackText?: string;
    tokenUsageLine?: string;
    failureMessage?: string;
    statusMessage?: string;
    completionNote?: string;
  },
): UiState {
  const activeAssistantTurnId = state.activeAssistantTurnId;
  if (!activeAssistantTurnId) {
    if (!params.fallbackText) {
      return state;
    }

      const turn = createTurn({
        id: nextTurnId("assistant", state.turns.length),
        role: "assistant",
        markdown: params.fallbackText,
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
      const markdown = hadStreamedText ? turn.markdown : (params.fallbackText ?? turn.markdown);
      return {
        ...turn,
        markdown,
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

function appendProcedureCard(
  state: UiState,
  card: Extract<RenderedFrontendEventEnvelope, { type: "procedure_card" }>["data"],
): UiState {
  const turns = state.activeAssistantTurnId
    ? state.turns.map((turn) => turn.id === state.activeAssistantTurnId && turn.status === "streaming"
      ? { ...turn, status: "complete" as const }
      : turn)
    : state.turns;
  const turn = createTurn({
    id: nextTurnId("assistant", turns.length),
    role: "assistant",
    markdown: renderProcedureCardMarkdown(card.card),
    status: "complete",
    runId: card.runId,
    displayStyle: "card",
    cardTone: procedureCardTone(card.card.kind),
    meta: buildAssistantTurnMeta({
      procedure: card.card.procedure,
    }),
  });

  return {
    ...state,
    turns: [...turns, turn],
    transcriptItems: appendTranscriptItem(state.transcriptItems, { type: "turn", id: turn.id }),
    activeAssistantTurnId: undefined,
    assistantParagraphBreakPending: false,
  };
}

function renderProcedureCardMarkdown(card: Extract<ProcedureUiEvent, { type: "card" }>): string {
  return [
    `## ${card.title}`,
    "",
    `_${card.kind}_`,
    "",
    card.markdown.trim(),
  ].filter((line, index, lines) => line.length > 0 || index < lines.length - 1).join("\n");
}

function procedureCardTone(kind: Extract<ProcedureUiEvent, { type: "card" }>["kind"]): NonNullable<UiTurn["cardTone"]> {
  switch (kind) {
    case "summary":
      return "success";
    case "checkpoint":
      return "warning";
    default:
      return "info";
  }
}

function buildAssistantTurnMeta(params: {
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

function mergeToolPreview(
  existing: UiToolCall["callPreview"],
  incoming: UiToolCall["callPreview"],
): UiToolCall["callPreview"] {
  if (!incoming) {
    return existing;
  }

  return {
    header: incoming.header ?? existing?.header,
    bodyLines: incoming.bodyLines ?? existing?.bodyLines,
    warnings: incoming.warnings ?? existing?.warnings,
    truncated: incoming.truncated ?? existing?.truncated,
  };
}

function upsertToolCall(toolCalls: UiToolCall[], nextToolCall: UiToolCall): UiToolCall[] {
  const existingIndex = toolCalls.findIndex((toolCall) => toolCall.id === nextToolCall.id);
  if (existingIndex < 0) {
    return [...toolCalls, nextToolCall];
  }

  return toolCalls.map((toolCall, index) => index === existingIndex ? nextToolCall : toolCall);
}

function removeToolCallAndReparent(toolCalls: UiToolCall[], toolCallId: string): UiToolCall[] {
  const removed = toolCalls.find((toolCall) => toolCall.id === toolCallId);
  if (!removed) {
    return toolCalls;
  }

  return recomputeToolCallDepths(
    toolCalls
      .filter((toolCall) => toolCall.id !== toolCallId)
      .map((toolCall) => toolCall.parentToolCallId === toolCallId
        ? setToolCallParent(toolCall, removed.parentToolCallId)
        : toolCall),
  );
}

function setToolCallParent(toolCall: UiToolCall, parentToolCallId: string | undefined): UiToolCall {
  if (parentToolCallId) {
    return {
      ...toolCall,
      parentToolCallId,
    };
  }

  const { parentToolCallId: _parentToolCallId, ...rest } = toolCall;
  void _parentToolCallId;
  return rest;
}

function recomputeToolCallDepths(toolCalls: UiToolCall[]): UiToolCall[] {
  const byId = new Map(toolCalls.map((toolCall) => [toolCall.id, toolCall]));
  const cachedDepths = new Map<string, number>();

  const resolveDepth = (toolCall: UiToolCall, lineage = new Set<string>()): number => {
    const cached = cachedDepths.get(toolCall.id);
    if (cached !== undefined) {
      return cached;
    }

    if (lineage.has(toolCall.id)) {
      return 0;
    }

    lineage.add(toolCall.id);
    const parent = toolCall.parentToolCallId ? byId.get(toolCall.parentToolCallId) : undefined;
    const depth = parent ? resolveDepth(parent, lineage) + 1 : 0;
    lineage.delete(toolCall.id);
    cachedDepths.set(toolCall.id, depth);
    return depth;
  };

  return toolCalls.map((toolCall) => ({
    ...toolCall,
    depth: resolveDepth(toolCall),
  }));
}

function appendTranscriptItem(items: UiTranscriptItem[], nextItem: UiTranscriptItem): UiTranscriptItem[] {
  const exists = items.some((item) => item.type === nextItem.type && item.id === nextItem.id);
  return exists ? items : [...items, nextItem];
}

function removeTranscriptItem(
  items: UiTranscriptItem[],
  type: UiTranscriptItem["type"],
  id: string,
): UiTranscriptItem[] {
  return items.filter((item) => !(item.type === type && item.id === id));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function appendUniqueString(values: string[], nextValue: string): string[] {
  return values.includes(nextValue) ? values : [...values, nextValue];
}

function isTerminalToolStatus(status: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function isStopRequestedForRun(state: UiState, runId: string): boolean {
  return state.stopRequestedRunId === runId;
}

function buildTurnCompletionNote(
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

function createAssistantTurn(state: UiState, markdown: string): UiTurn {
  return createTurn({
    id: nextTurnId("assistant", state.turns.length),
    role: "assistant",
    markdown,
    status: "streaming",
    runId: state.activeRunId,
    meta: buildAssistantTurnMeta({
      procedure: state.activeProcedure,
    }),
  });
}

function createTurn(turn: UiTurn): UiTurn {
  return turn;
}

function nextTurnId(role: UiTurn["role"], index: number): string {
  return `${role}-${index + 1}`;
}
