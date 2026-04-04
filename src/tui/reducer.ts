import type { FrontendCommand, FrontendEventEnvelope } from "../frontend-events.ts";
import type { DownstreamAgentSelection } from "../types.ts";

import {
  formatMemoryCardsLines,
  formatPromptDiagnosticsLine,
  formatStoredMemoryCardLines,
  formatTokenUsageLine,
  isWrapperToolTitle,
  shouldSuppressToolTraceTitle,
} from "./format.ts";
import { LOCAL_TUI_COMMANDS } from "./commands.ts";
import {
  createInitialUiState,
  type UiState,
  type UiToolCall,
  type UiTranscriptItem,
  type UiTurn,
} from "./state.ts";

const MAX_RUNTIME_NOTES = 8;

export type UiAction =
  | {
      type: "session_ready";
      sessionId: string;
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
      type: "local_agent_selection";
      agentLabel: string;
      selection: DownstreamAgentSelection;
    }
  | {
      type: "frontend_event";
      event: FrontendEventEnvelope;
    };

export function reduceUiState(state: UiState, action: UiAction): UiState {
  switch (action.type) {
    case "session_ready":
      return {
        ...createInitialUiState({
          cwd: state.cwd,
          buildLabel: action.buildLabel,
          agentLabel: action.agentLabel,
          showToolCalls: state.showToolCalls,
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
        runtimeNotes: [],
        activeWrapperToolCallIds: [],
        hiddenToolCallIds: [],
        activeRunId: undefined,
        activeProcedure: undefined,
        activeAssistantTurnId: undefined,
        assistantParagraphBreakPending: undefined,
        promptDiagnosticsLine: undefined,
        tokenUsageLine: undefined,
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
        activeWrapperToolCallIds: [],
        hiddenToolCallIds: [],
        statusLine: `[run] ${action.error}`,
        inputDisabled: false,
      };
    }
    case "local_status":
      return {
        ...state,
        statusLine: action.text,
      };
    case "local_agent_selection":
      return {
        ...state,
        agentLabel: action.agentLabel,
        defaultAgentSelection: action.selection,
      };
    case "frontend_event":
      return reduceFrontendEvent(state, action.event);
  }
}

function reduceFrontendEvent(state: UiState, event: FrontendEventEnvelope): UiState {
  switch (event.type) {
    case "commands_updated":
      return {
        ...state,
        availableCommands: mergeAvailableCommands(event.data.commands),
      };
    case "run_started":
      return {
        ...state,
        activeWrapperToolCallIds: [],
        hiddenToolCallIds: [],
        runtimeNotes: [],
        promptDiagnosticsLine: undefined,
        tokenUsageLine: undefined,
        activeRunId: event.data.runId,
        activeProcedure: event.data.procedure,
        activeAssistantTurnId: undefined,
        assistantParagraphBreakPending: undefined,
        runStartedAtMs: Date.parse(event.data.startedAt) || Date.now(),
        statusLine: `[run] ${event.data.procedure} working…`,
        inputDisabled: true,
      };
    case "memory_cards":
      return appendRuntimeLines(state, formatMemoryCardsLines(event.data.cards));
    case "memory_card_stored":
      return appendRuntimeLines(state, formatStoredMemoryCardLines(event.data.card, {
        method: event.data.estimateMethod,
        encoding: event.data.estimateEncoding,
      }));
    case "prompt_diagnostics":
      return {
        ...state,
        promptDiagnosticsLine: formatPromptDiagnosticsLine(event.data.diagnostics),
      };
    case "text_delta":
      return appendAssistantText(state, event.data.text);
    case "token_usage":
      return {
        ...state,
        tokenUsageLine: formatTokenUsageLine(event.data.usage),
      };
    case "run_heartbeat": {
      const now = Date.parse(event.data.at) || Date.now();
      const startedAt = state.runStartedAtMs ?? now;
      const elapsedSeconds = Math.max(1, Math.round((now - startedAt) / 1_000));
      return {
        ...state,
        statusLine: `[run] ${event.data.procedure} still working (${elapsedSeconds}s)`,
      };
    }
    case "tool_started": {
      const depth = state.activeWrapperToolCallIds.length;
      const isWrapper = isWrapperToolTitle(event.data.title);
      const suppressed = shouldSuppressToolTraceTitle(event.data.title);
      const activeWrapperToolCallIds = isWrapper && !state.activeWrapperToolCallIds.includes(event.data.toolCallId)
        ? [...state.activeWrapperToolCallIds, event.data.toolCallId]
        : state.activeWrapperToolCallIds;
      const hiddenToolCallIds = suppressed && !state.hiddenToolCallIds.includes(event.data.toolCallId)
        ? [...state.hiddenToolCallIds, event.data.toolCallId]
        : state.hiddenToolCallIds;

      if (!state.showToolCalls || suppressed) {
        return {
          ...state,
          activeWrapperToolCallIds,
          hiddenToolCallIds,
        };
      }

      const existing = state.toolCalls.find((toolCall) => toolCall.id === event.data.toolCallId);
      const nextToolCall: UiToolCall = {
        id: event.data.toolCallId,
        runId: event.data.runId,
        title: event.data.title,
        kind: event.data.kind,
        status: event.data.status ?? existing?.status ?? "pending",
        depth: existing?.depth ?? depth,
        isWrapper: existing?.isWrapper ?? isWrapper,
        inputSummary: event.data.inputSummary ?? existing?.inputSummary,
        outputSummary: existing?.outputSummary,
        errorSummary: existing?.errorSummary,
        durationMs: existing?.durationMs,
      };

      const nextState = {
        ...state,
        toolCalls: upsertToolCall(state.toolCalls, nextToolCall),
        transcriptItems: appendTranscriptItem(state.transcriptItems, { type: "tool_call", id: nextToolCall.id }),
        activeWrapperToolCallIds,
        hiddenToolCallIds,
      };
      return existing ? nextState : markAssistantTextBoundary(nextState);
    }
    case "tool_updated": {
      const existing = state.toolCalls.find((toolCall) => toolCall.id === event.data.toolCallId);
      const title = event.data.title ?? existing?.title ?? event.data.toolCallId;
      const depth = existing?.depth ?? getActiveWrapperDepth(state.activeWrapperToolCallIds, event.data.toolCallId);
      const isWrapper = existing?.isWrapper ?? (
        state.activeWrapperToolCallIds.includes(event.data.toolCallId) || isWrapperToolTitle(title)
      );
      const suppressed = state.hiddenToolCallIds.includes(event.data.toolCallId) || shouldSuppressToolTraceTitle(title);
      const activeWrapperToolCallIds = isWrapper && isTerminalToolStatus(event.data.status)
        ? state.activeWrapperToolCallIds.filter((toolCallId) => toolCallId !== event.data.toolCallId)
        : state.activeWrapperToolCallIds;
      const hiddenToolCallIds = suppressed && isTerminalToolStatus(event.data.status)
        ? state.hiddenToolCallIds.filter((toolCallId) => toolCallId !== event.data.toolCallId)
        : suppressed && !state.hiddenToolCallIds.includes(event.data.toolCallId)
          ? [...state.hiddenToolCallIds, event.data.toolCallId]
          : state.hiddenToolCallIds;

      let toolCalls = suppressed && isWrapper && isTerminalToolStatus(event.data.status)
        ? collapseToolCallBranch(state.toolCalls, depth)
        : state.toolCalls;
      let transcriptItems = state.transcriptItems;

      if (!state.showToolCalls || suppressed) {
        return {
          ...state,
          toolCalls,
          transcriptItems,
          activeWrapperToolCallIds,
          hiddenToolCallIds,
        };
      }

      const nextToolCall: UiToolCall = {
        id: event.data.toolCallId,
        runId: event.data.runId,
        title,
        kind: existing?.kind ?? "other",
        status: event.data.status,
        depth,
        isWrapper,
        inputSummary: existing?.inputSummary,
        outputSummary: event.data.outputSummary ?? existing?.outputSummary,
        errorSummary: event.data.errorSummary ?? existing?.errorSummary,
        durationMs: event.data.durationMs ?? existing?.durationMs,
      };

      if (isWrapper && event.data.status === "completed") {
        toolCalls = collapseToolCallBranch(removeToolCall(toolCalls, event.data.toolCallId), depth);
        transcriptItems = removeTranscriptItem(transcriptItems, "tool_call", event.data.toolCallId);
      } else {
        toolCalls = upsertToolCall(toolCalls, nextToolCall);
        transcriptItems = appendTranscriptItem(transcriptItems, { type: "tool_call", id: nextToolCall.id });
      }

      const nextState = {
        ...state,
        toolCalls,
        transcriptItems,
        activeWrapperToolCallIds,
        hiddenToolCallIds,
      };
      return existing || (isWrapper && event.data.status === "completed") ? nextState : markAssistantTextBoundary(nextState);
    }
    case "run_completed": {
      const tokenUsageLine = event.data.tokenUsage ? formatTokenUsageLine(event.data.tokenUsage) : state.tokenUsageLine;
      const nextState = finalizeAssistantTurn(state, {
        status: "complete",
        fallbackText: event.data.display,
        tokenUsageLine,
      });
      return {
        ...nextState,
        activeRunId: undefined,
        activeProcedure: undefined,
        activeAssistantTurnId: undefined,
        assistantParagraphBreakPending: undefined,
        runStartedAtMs: undefined,
        activeWrapperToolCallIds: [],
        hiddenToolCallIds: [],
        tokenUsageLine,
        statusLine: `[run] ${event.data.procedure} completed`,
        inputDisabled: false,
      };
    }
    case "run_failed":
      return {
        ...finalizeAssistantTurn(state, {
          status: "failed",
          fallbackText: event.data.error,
          failureMessage: event.data.error,
        }),
        activeRunId: undefined,
        activeProcedure: undefined,
        activeAssistantTurnId: undefined,
        assistantParagraphBreakPending: undefined,
        runStartedAtMs: undefined,
        activeWrapperToolCallIds: [],
        hiddenToolCallIds: [],
        statusLine: `[run] ${event.data.error}`,
        inputDisabled: false,
      };
  }
}

function mergeAvailableCommands(commands: FrontendCommand[]): string[] {
  return uniqueStrings([
    ...commands.map((command) => `/${command.name}`),
    ...LOCAL_TUI_COMMANDS.map((command) => command.name),
  ]);
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

function finalizeAssistantTurn(
  state: UiState,
  params: {
    status: UiTurn["status"];
    fallbackText?: string;
    tokenUsageLine?: string;
    failureMessage?: string;
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
      meta: buildAssistantTurnMeta({
        procedure: state.activeProcedure,
        tokenUsageLine: params.tokenUsageLine,
        failureMessage: undefined,
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
        meta: buildAssistantTurnMeta({
          existing: turn.meta,
          procedure: turn.meta?.procedure ?? state.activeProcedure,
          tokenUsageLine: params.tokenUsageLine,
          failureMessage: hadStreamedText ? params.failureMessage : undefined,
        }),
      };
    }),
  };
}

function appendRuntimeLines(state: UiState, lines: string[]): UiState {
  return {
    ...state,
    runtimeNotes: [...state.runtimeNotes, ...lines].slice(-MAX_RUNTIME_NOTES),
  };
}

function buildAssistantTurnMeta(params: {
  existing?: UiTurn["meta"];
  procedure?: string;
  tokenUsageLine?: string;
  failureMessage?: string;
}): UiTurn["meta"] | undefined {
  const meta = {
    ...params.existing,
    procedure: params.procedure ?? params.existing?.procedure,
    tokenUsageLine: params.tokenUsageLine ?? params.existing?.tokenUsageLine,
    failureMessage: params.failureMessage,
  };

  return meta.procedure || meta.tokenUsageLine || meta.failureMessage ? meta : undefined;
}

function collapseToolCallBranch(toolCalls: UiToolCall[], depth: number): UiToolCall[] {
  return toolCalls.map((toolCall) => toolCall.depth > depth
    ? {
        ...toolCall,
        depth: toolCall.depth - 1,
      }
    : toolCall);
}

function upsertToolCall(toolCalls: UiToolCall[], nextToolCall: UiToolCall): UiToolCall[] {
  const existingIndex = toolCalls.findIndex((toolCall) => toolCall.id === nextToolCall.id);
  if (existingIndex < 0) {
    return [...toolCalls, nextToolCall];
  }

  return toolCalls.map((toolCall, index) => index === existingIndex ? nextToolCall : toolCall);
}

function removeToolCall(toolCalls: UiToolCall[], toolCallId: string): UiToolCall[] {
  return toolCalls.filter((toolCall) => toolCall.id !== toolCallId);
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

function getActiveWrapperDepth(activeWrapperToolCallIds: string[], toolCallId: string): number {
  const depth = activeWrapperToolCallIds.indexOf(toolCallId);
  return depth >= 0 ? depth : activeWrapperToolCallIds.length;
}

function isTerminalToolStatus(status: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
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
