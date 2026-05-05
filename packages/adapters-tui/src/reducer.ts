import {
  type FrontendCommand,
  type RenderedFrontendEventEnvelope,
} from "@nanoboss/adapters-http";
import type { DownstreamAgentSelection } from "@nanoboss/contracts";
import { formatProcedureStatusText, type ProcedureUiEvent } from "@nanoboss/procedure-engine";
import type { ToolCardThemeMode } from "./theme.ts";

import { formatTokenUsageLine, toTokenUsageSummary } from "./format.ts";
import { LOCAL_TUI_COMMANDS } from "./commands.ts";
import { getPanelRenderer } from "./panel-renderers.ts";
import {
  nbCardV1Tone,
  renderNbCardV1Markdown,
  type NbCardV1Payload,
} from "./core-panels.ts";
import {
  createInitialUiState,
  type UiPanel,
  type UiPendingPrompt,
  type UiProcedurePanel,
  type UiState,
  type UiToolCall,
  type UiTranscriptItem,
  type UiTurn,
} from "./state.ts";
import {
  appendUniqueString,
  isTerminalToolStatus,
  mergeToolPreview,
  recomputeToolCallDepths,
  removeToolCallAndReparent,
  upsertToolCall,
} from "./reducer-tool-calls.ts";
import {
  appendAssistantText,
  appendTextToTurnBlocks,
  appendToolCallBlockToActiveTurn,
  appendTranscriptItem,
  buildAssistantTurnMeta,
  createTurn,
  markAssistantTextBoundary,
  nextTurnId,
  removeTranscriptItem,
} from "./reducer-turns.ts";
import {
  buildContinuationStatusLine,
  buildDismissContinuationStatusLine,
  evictPanelsByLifetime,
  finishRun,
} from "./reducer-run-completion.ts";

const STOP_REQUESTED_STATUS = "[run] ESC received - stopping at next tool boundary...";

export type UiAction =
  | {
      type: "session_ready";
      sessionId: string;
      cwd: string;
      buildLabel: string;
      agentLabel: string;
      autoApprove: boolean;
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
      type: "local_busy_started";
      text: string;
    }
  | {
      type: "local_busy_finished";
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
      type: "session_auto_approve";
      enabled: boolean;
    }
  | {
      type: "toggle_tool_output";
    }
  | {
      type: "toggle_tool_cards_hidden";
    }
  | {
      /**
       * Insert (or in-place replace) a procedure-panel-shaped transcript
       * card from a local source such as a slash command. Unlike a real
       * `procedure_panel` frontend event this action:
       *
       * - Does NOT bind to `activeAssistantTurnId` (no turnId).
       * - Does NOT call `appendProcedurePanelBlockToActiveTurn`, so a
       *   mid-run `/extensions` cannot split the streaming assistant
       *   turn into multiple turns.
       * - Does NOT call `markAssistantTextBoundary`.
       *
       * In-place replacement keys by (rendererId, key) with runId always
       * undefined so repeated invocations of the same local command
       * collapse onto a single transcript card.
       */
      type: "local_procedure_panel";
      panelId: string;
      rendererId: string;
      payload: unknown;
      severity: "info" | "warn" | "error";
      dismissible: boolean;
      key?: string;
      procedure?: string;
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
          simplify2AutoApprove: action.autoApprove,
          toolCardsHidden: state.toolCardsHidden,
        }),
        sessionId: action.sessionId,
        buildLabel: action.buildLabel,
        agentLabel: action.agentLabel,
        simplify2AutoApprove: action.autoApprove,
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
        inputDisabledReason: "run",
        panels: evictPanelsByLifetime(state.panels, {
          scopes: ["turn"],
        }),
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
        inputDisabledReason: undefined,
      };
    }
    case "local_status":
      return {
        ...state,
        statusLine: action.text,
      };
    case "local_busy_started":
      return {
        ...state,
        statusLine: action.text,
        inputDisabled: true,
        inputDisabledReason: "local",
      };
    case "local_busy_finished":
      if (state.inputDisabledReason !== "local") {
        return state;
      }
      return {
        ...state,
        statusLine: undefined,
        inputDisabled: false,
        inputDisabledReason: undefined,
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
      };
    case "local_simplify2_auto_approve":
      return {
        ...state,
        simplify2AutoApprove: action.enabled,
        statusLine: `[simplify2] auto-approve ${action.enabled ? "on" : "off"}`,
      };
    case "session_auto_approve":
      return {
        ...state,
        simplify2AutoApprove: action.enabled,
        statusLine: `[session] auto-approve ${action.enabled ? "on" : "off"}`,
      };
    case "toggle_tool_output":
      return {
        ...state,
        expandedToolOutput: !state.expandedToolOutput,
      };
    case "toggle_tool_cards_hidden":
      return {
        ...state,
        toolCardsHidden: !state.toolCardsHidden,
      };
    case "frontend_event":
      return reduceFrontendEvent(state, action.event);
    case "local_procedure_panel":
      return applyLocalProcedurePanel(state, action);
  }
}

function applyLocalProcedurePanel(
  state: UiState,
  action: Extract<UiAction, { type: "local_procedure_panel" }>,
): UiState {
  const existingByKey = action.key
    ? state.procedurePanels.find((p) =>
      p.key === action.key
        && p.rendererId === action.rendererId
        && p.runId === undefined
    )
    : undefined;

  if (existingByKey) {
    const updated: UiProcedurePanel = {
      ...existingByKey,
      rendererId: action.rendererId,
      payload: action.payload,
      severity: action.severity,
      dismissible: action.dismissible,
      procedure: action.procedure,
    };
    return {
      ...state,
      turns: replaceProcedurePanelBlockInTurns(state.turns, existingByKey.panelId, updated),
      procedurePanels: state.procedurePanels.map((p) =>
        p.panelId === existingByKey.panelId ? updated : p,
      ),
    };
  }

  const entry: UiProcedurePanel = {
    panelId: action.panelId,
    rendererId: action.rendererId,
    payload: action.payload,
    severity: action.severity,
    dismissible: action.dismissible,
    ...(action.key !== undefined ? { key: action.key } : {}),
    ...(action.procedure !== undefined ? { procedure: action.procedure } : {}),
  };

  return {
    ...state,
    procedurePanels: [...state.procedurePanels, entry],
    transcriptItems: appendTranscriptItem(state.transcriptItems, {
      type: "procedure_panel",
      id: entry.panelId,
    }),
  };
}

function reduceFrontendEvent(state: UiState, event: RenderedFrontendEventEnvelope): UiState {
  switch (event.type) {
    case "commands_updated":
      return {
        ...state,
        availableCommands: mergeAvailableCommands(event.data.commands),
      };
    case "run_restored": {
      const pendingContinuation = event.data.status === "paused"
        ? {
            procedure: event.data.procedure,
            question: "",
          }
        : state.pendingContinuation;
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
          pendingContinuation,
        };
      }

      const assistantTurn = createTurn({
        id: nextTurnId("assistant", nextTurns.length),
        role: "assistant",
        markdown: event.data.text,
        blocks: event.data.text.length > 0
          ? [{ kind: "text", text: event.data.text, origin: "replay" }]
          : [],
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
        pendingContinuation,
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
        inputDisabledReason: "run",
      };
    }
    case "continuation_updated":
      return {
        ...state,
        pendingContinuation: event.data.continuation,
      };
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
    case "ui_panel":
      if (shouldIgnoreMismatchedRunEvent(state, event.data.runId)) {
        return state;
      }
      return applyUiPanel(state, event.data);
    case "procedure_panel":
      if (shouldIgnoreMismatchedRunEvent(state, event.data.runId)) {
        return state;
      }
      return applyProcedurePanel(state, event.data);
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
        tokenUsage: toTokenUsageSummary(event.data.usage),
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
      return existing || !transcriptVisible
        ? nextState
        : markAssistantTextBoundary(appendToolCallBlockToActiveTurn(nextState, event.data.toolCallId));
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
      const tokenUsage = event.data.tokenUsage ? toTokenUsageSummary(event.data.tokenUsage) : state.tokenUsage;
      const statusLine = event.data.procedure === "dismiss"
        ? buildDismissContinuationStatusLine(event.data.display)
        : `[run] ${event.data.procedure} completed`;
      return finishRun(state, {
        turnStatus: "complete",
        completionText: event.data.display,
        tokenUsageLine,
        tokenUsage,
        completedAt: event.data.completedAt,
        statusLine,
      });
    }
    case "run_paused": {
      if (shouldIgnoreMismatchedRunEvent(state, event.data.runId)) {
        return state;
      }
      const tokenUsageLine = event.data.tokenUsage ? formatTokenUsageLine(event.data.tokenUsage) : state.tokenUsageLine;
      const tokenUsage = event.data.tokenUsage ? toTokenUsageSummary(event.data.tokenUsage) : state.tokenUsage;
      const nextState = finishRun(state, {
        turnStatus: "complete",
        completionText: event.data.display ?? event.data.question,
        tokenUsageLine,
        tokenUsage,
        completedAt: event.data.pausedAt,
        statusLine: buildContinuationStatusLine(event.data.procedure),
      });
      return {
        ...nextState,
        pendingContinuation: {
          procedure: event.data.procedure,
          question: event.data.question,
          inputHint: event.data.inputHint,
          suggestedReplies: event.data.suggestedReplies,
          form: event.data.form,
        },
      };
    }
    case "run_failed": {
      if (shouldIgnoreMismatchedRunEvent(state, event.data.runId)) {
        return state;
      }
      const nextState = finishRun(state, {
        turnStatus: "failed",
        completionText: event.data.error,
        failureMessage: event.data.error,
        completedAt: event.data.completedAt,
        statusLine: `[run] ${event.data.error}`,
      });
      return { ...nextState, pendingContinuation: undefined };
    }
    case "run_cancelled": {
      if (shouldIgnoreMismatchedRunEvent(state, event.data.runId)) {
        return state;
      }
      const nextState = finishRun(state, {
        turnStatus: "cancelled",
        completionText: event.data.message,
        statusMessage: event.data.message,
        completedAt: event.data.completedAt,
        statusLine: `[run] ${event.data.procedure} stopped`,
      });
      return { ...nextState, pendingContinuation: undefined };
    }
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

function applyProcedurePanel(
  state: UiState,
  data: Extract<RenderedFrontendEventEnvelope, { type: "procedure_panel" }>["data"],
): UiState {
  const existingByKey = data.key
    ? state.procedurePanels.find((p) =>
      p.key === data.key
        && p.rendererId === data.rendererId
        && p.runId === data.runId
    )
    : undefined;

  if (existingByKey) {
    // Replace in place, preserving ordering and transcript item.
    const updated: UiProcedurePanel = {
      ...existingByKey,
      rendererId: data.rendererId,
      payload: data.payload,
      severity: data.severity,
      dismissible: data.dismissible,
      procedure: data.procedure,
    };
    return {
      ...state,
      turns: replaceProcedurePanelBlockInTurns(state.turns, existingByKey.panelId, updated),
      procedurePanels: state.procedurePanels.map((p) =>
        p.panelId === existingByKey.panelId ? updated : p,
      ),
    };
  }

  const entry: UiProcedurePanel = {
    panelId: data.panelId,
    rendererId: data.rendererId,
    payload: data.payload,
    severity: data.severity,
    dismissible: data.dismissible,
    ...(data.key !== undefined ? { key: data.key } : {}),
    ...(data.runId ? { runId: data.runId } : {}),
    ...(state.activeAssistantTurnId ? { turnId: state.activeAssistantTurnId } : {}),
    procedure: data.procedure,
  };

  const nextState: UiState = {
    ...state,
    procedurePanels: [...state.procedurePanels, entry],
    transcriptItems: appendTranscriptItem(state.transcriptItems, {
      type: "procedure_panel",
      id: entry.panelId,
    }),
  };

  // Preserve ordering relative to text_delta and tool_call blocks using
  // the same boundary rule as tool calls.
  const withBlock = appendProcedurePanelBlockToActiveTurn(nextState, entry);
  return markAssistantTextBoundary(withBlock);
}

function appendProcedurePanelBlockToActiveTurn(
  state: UiState,
  panel: UiProcedurePanel,
): UiState {
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
      return {
        ...turn,
        blocks: [
          ...blocks,
          {
            kind: "procedure_panel" as const,
            panelId: panel.panelId,
            rendererId: panel.rendererId,
            payload: panel.payload,
            severity: panel.severity,
            dismissible: panel.dismissible,
            ...(panel.key !== undefined ? { key: panel.key } : {}),
          },
        ],
      };
    }),
  };
}

function replaceProcedurePanelBlockInTurns(
  turns: UiTurn[],
  panelId: string,
  panel: UiProcedurePanel,
): UiTurn[] {
  return turns.map((turn) => {
    if (!turn.blocks?.some((block) => block.kind === "procedure_panel" && block.panelId === panelId)) {
      return turn;
    }
    return {
      ...turn,
      blocks: turn.blocks.map((block) =>
        block.kind === "procedure_panel" && block.panelId === panelId
          ? {
              kind: "procedure_panel" as const,
              panelId,
              rendererId: panel.rendererId,
              payload: panel.payload,
              severity: panel.severity,
              dismissible: panel.dismissible,
              ...(panel.key !== undefined ? { key: panel.key } : {}),
            }
          : block
      ),
    };
  });
}

function applyUiPanel(
  state: UiState,
  data: Extract<RenderedFrontendEventEnvelope, { type: "ui_panel" }>["data"],
): UiState {
  const renderer = getPanelRenderer(data.rendererId);
  if (!renderer) {
    return withDiagnosticStatus(
      state,
      `[panel] unknown renderer "${data.rendererId}"`,
    );
  }

  if (!renderer.schema.validate(data.payload)) {
    return withDiagnosticStatus(
      state,
      `[panel] invalid payload for "${data.rendererId}"`,
    );
  }

  if (data.rendererId === "nb/card@1" && data.slot === "transcript") {
    const payload = data.payload as NbCardV1Payload;
    const turns = state.activeAssistantTurnId
      ? state.turns.map((turn) => turn.id === state.activeAssistantTurnId && turn.status === "streaming"
        ? { ...turn, status: "complete" as const }
        : turn)
      : state.turns;
    const turn = createTurn({
      id: nextTurnId("assistant", turns.length),
      role: "assistant",
      markdown: renderNbCardV1Markdown(payload),
      status: "complete",
      runId: data.runId,
      displayStyle: "card",
      cardTone: nbCardV1Tone(payload.kind),
      meta: buildAssistantTurnMeta({
        procedure: data.procedure,
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

  const entry: UiPanel = {
    rendererId: data.rendererId,
    slot: data.slot,
    ...(data.key !== undefined ? { key: data.key } : {}),
    payload: data.payload,
    lifetime: data.lifetime,
    ...(data.runId ? { runId: data.runId } : {}),
    ...(state.activeAssistantTurnId ? { turnId: state.activeAssistantTurnId } : {}),
  };

  const remaining = state.panels.filter((existing) => !isSamePanelKey(existing, entry));
  return {
    ...state,
    panels: [...remaining, entry],
  };
}

function isSamePanelKey(a: UiPanel, b: UiPanel): boolean {
  return a.rendererId === b.rendererId && (a.key ?? undefined) === (b.key ?? undefined);
}

function withDiagnosticStatus(state: UiState, text: string): UiState {
  return {
    ...state,
    statusLine: text,
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

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function isStopRequestedForRun(state: UiState, runId: string): boolean {
  return state.stopRequestedRunId === runId;
}
