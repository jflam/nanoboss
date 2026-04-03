import type { FrontendEventEnvelope, FrontendCommand } from "../frontend-events.ts";
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
import { createInitialUiState, type UiState, type UiToolCall, type UiTurn } from "./state.ts";

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
    case "local_user_submitted":
      return {
        ...state,
        turns: [
          ...state.turns,
          {
            id: nextTurnId("user", state.turns.length),
            role: "user",
            markdown: action.text,
            status: "complete",
          },
        ],
        runtimeNotes: [],
        toolCalls: [],
        activeWrapperToolCallIds: [],
        hiddenToolCallIds: [],
        promptDiagnosticsLine: undefined,
        tokenUsageLine: undefined,
        assistantParagraphBreakPending: undefined,
        statusLine: "[run] waiting for response",
        inputDisabled: true,
      };
    case "local_send_failed":
      return {
        ...state,
        turns: [
          ...state.turns,
          {
            id: nextTurnId("system", state.turns.length),
            role: "system",
            markdown: action.error,
            status: "failed",
          },
        ],
        activeRunId: undefined,
        activeAssistantTurnId: undefined,
        assistantParagraphBreakPending: undefined,
        runStartedAtMs: undefined,
        toolCalls: [],
        activeWrapperToolCallIds: [],
        hiddenToolCallIds: [],
        statusLine: `[run] ${action.error}`,
        inputDisabled: false,
      };
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
    case "run_started": {
      const assistantTurnId = nextTurnId("assistant", state.turns.length);
      return {
        ...state,
        turns: [
          ...state.turns,
          {
            id: assistantTurnId,
            role: "assistant",
            markdown: "",
            status: "streaming",
            meta: {
              procedure: event.data.procedure,
            },
          },
        ],
        toolCalls: [],
        activeWrapperToolCallIds: [],
        hiddenToolCallIds: [],
        runtimeNotes: [],
        promptDiagnosticsLine: undefined,
        tokenUsageLine: undefined,
        activeRunId: event.data.runId,
        activeAssistantTurnId: assistantTurnId,
        assistantParagraphBreakPending: undefined,
        runStartedAtMs: Date.parse(event.data.startedAt) || Date.now(),
        statusLine: `[run] ${event.data.procedure} working…`,
        inputDisabled: true,
      };
    }
    case "memory_cards":
      return markAssistantTextBoundary(appendRuntimeLines(state, formatMemoryCardsLines(event.data.cards)));
    case "memory_card_stored":
      return markAssistantTextBoundary(appendRuntimeLines(state, formatStoredMemoryCardLines(event.data.card, {
        method: event.data.estimateMethod,
        encoding: event.data.estimateEncoding,
      })));
    case "prompt_diagnostics":
      return markAssistantTextBoundary({
        ...state,
        promptDiagnosticsLine: formatPromptDiagnosticsLine(event.data.diagnostics),
      });
    case "text_delta":
      return appendAssistantText(state, event.data.text);
    case "token_usage":
      return markAssistantTextBoundary({
        ...state,
        tokenUsageLine: formatTokenUsageLine(event.data.usage),
      });
    case "run_heartbeat": {
      const now = Date.parse(event.data.at) || Date.now();
      const startedAt = state.runStartedAtMs ?? now;
      const elapsedSeconds = Math.max(1, Math.round((now - startedAt) / 1_000));
      return markAssistantTextBoundary({
        ...state,
        statusLine: `[run] ${event.data.procedure} still working (${elapsedSeconds}s)`,
      });
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
        title: event.data.title,
        status: event.data.status ?? "pending",
        depth: existing?.depth ?? depth,
        isWrapper: existing?.isWrapper ?? isWrapper,
      };

      return markAssistantTextBoundary({
        ...state,
        toolCalls: upsertToolCall(pruneReplacedCompletedToolCalls(state.toolCalls, nextToolCall.depth), nextToolCall),
        activeWrapperToolCallIds,
        hiddenToolCallIds,
      });
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
      const toolCalls = suppressed && isWrapper && isTerminalToolStatus(event.data.status)
        ? collapseSuppressedWrapperBranch(state.toolCalls, depth)
        : state.toolCalls;

      if (!state.showToolCalls || suppressed) {
        return {
          ...state,
          toolCalls,
          activeWrapperToolCallIds,
          hiddenToolCallIds,
        };
      }

      if (event.data.status === "completed") {
        if (isWrapper) {
          return markAssistantTextBoundary({
            ...state,
            toolCalls: removeCompletedWrapperBranch(state.toolCalls, event.data.toolCallId, depth),
            activeWrapperToolCallIds,
            hiddenToolCallIds,
          });
        }

        const nextToolCall: UiToolCall = {
          id: event.data.toolCallId,
          title,
          status: event.data.status,
          depth,
          isWrapper,
        };

        return markAssistantTextBoundary({
          ...state,
          toolCalls: upsertToolCall(state.toolCalls, nextToolCall),
          activeWrapperToolCallIds,
          hiddenToolCallIds,
        });
      }

      const nextToolCall: UiToolCall = {
        id: event.data.toolCallId,
        title,
        status: event.data.status,
        depth,
        isWrapper,
      };

      return markAssistantTextBoundary({
        ...state,
        toolCalls: upsertToolCall(state.toolCalls, nextToolCall),
        activeWrapperToolCallIds,
        hiddenToolCallIds,
      });
    }
    case "run_completed": {
      const tokenUsageLine = event.data.tokenUsage ? formatTokenUsageLine(event.data.tokenUsage) : state.tokenUsageLine;
      let nextState = finalizeAssistantTurn(state, {
        status: "complete",
        fallbackText: event.data.display,
        tokenUsageLine,
      });
      nextState = {
        ...nextState,
        activeRunId: undefined,
        activeAssistantTurnId: undefined,
        assistantParagraphBreakPending: undefined,
        runStartedAtMs: undefined,
        toolCalls: [],
        activeWrapperToolCallIds: [],
        hiddenToolCallIds: [],
        tokenUsageLine,
        statusLine: `[run] ${event.data.procedure} completed`,
        inputDisabled: false,
      };
      return nextState;
    }
    case "run_failed":
      return {
        ...finalizeAssistantTurn(state, {
          status: "failed",
          fallbackText: event.data.error,
          failureMessage: event.data.error,
        }),
        activeRunId: undefined,
        activeAssistantTurnId: undefined,
        assistantParagraphBreakPending: undefined,
        runStartedAtMs: undefined,
        toolCalls: [],
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
  if (!activeAssistantTurnId) {
    const assistantTurn: UiTurn = {
      id: nextTurnId("assistant", state.turns.length),
      role: "assistant",
      markdown: text,
      status: "streaming",
    };

    return {
      ...state,
      turns: [...state.turns, assistantTurn],
      activeAssistantTurnId: assistantTurn.id,
      assistantParagraphBreakPending: false,
    };
  }

  return {
    ...state,
    turns: state.turns.map((turn) => {
      if (turn.id !== activeAssistantTurnId) {
        return turn;
      }

      const separator = shouldInsertAssistantParagraphBreak(turn.markdown, text, state.assistantParagraphBreakPending)
        ? "\n\n"
        : "";

      return {
        ...turn,
        markdown: `${turn.markdown}${separator}${text}`,
      };
    }),
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

function shouldInsertAssistantParagraphBreak(previousText: string, nextText: string, pendingBoundary?: boolean): boolean {
  if (!pendingBoundary) {
    return false;
  }

  const previousTrimmed = previousText.trimEnd();
  const nextTrimmed = nextText.trimStart();
  if (previousTrimmed.length === 0 || nextTrimmed.length === 0) {
    return false;
  }

  if (/\n\s*$/.test(previousText) || /^\s/.test(nextText)) {
    return false;
  }

  return /[.!?:]$/.test(previousTrimmed) && /^[A-Z0-9`"'/(\[]/.test(nextTrimmed);
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

    return {
      ...state,
      turns: [
        ...state.turns,
        {
          id: nextTurnId("assistant", state.turns.length),
          role: "assistant",
          markdown: params.fallbackText,
          status: params.status,
          meta: buildAssistantTurnMeta({
            tokenUsageLine: params.tokenUsageLine,
            failureMessage: undefined,
          }),
        },
      ],
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
  tokenUsageLine?: string;
  failureMessage?: string;
}): UiTurn["meta"] | undefined {
  const meta = {
    ...params.existing,
    tokenUsageLine: params.tokenUsageLine ?? params.existing?.tokenUsageLine,
    failureMessage: params.failureMessage,
  };

  return meta.procedure || meta.tokenUsageLine || meta.failureMessage ? meta : undefined;
}

function pruneReplacedCompletedToolCalls(toolCalls: UiToolCall[], depth: number): UiToolCall[] {
  return toolCalls.filter((toolCall) => !(toolCall.depth === depth && !toolCall.isWrapper && toolCall.status === "completed"));
}

function collapseSuppressedWrapperBranch(toolCalls: UiToolCall[], depth: number): UiToolCall[] {
  return toolCalls.map((toolCall) => toolCall.depth > depth
    ? {
        ...toolCall,
        depth: toolCall.depth - 1,
      }
    : toolCall);
}

function removeCompletedWrapperBranch(toolCalls: UiToolCall[], toolCallId: string, depth: number): UiToolCall[] {
  return toolCalls.filter((toolCall) => toolCall.id !== toolCallId && toolCall.depth <= depth);
}

function upsertToolCall(toolCalls: UiToolCall[], nextToolCall: UiToolCall): UiToolCall[] {
  const existingIndex = toolCalls.findIndex((toolCall) => toolCall.id === nextToolCall.id);
  if (existingIndex < 0) {
    return [...toolCalls, nextToolCall];
  }

  return toolCalls.map((toolCall, index) => index === existingIndex ? nextToolCall : toolCall);
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

function nextTurnId(role: UiTurn["role"], index: number): string {
  return `${role}-${index + 1}`;
}
