import type { RenderedFrontendEventEnvelope } from "@nanoboss/adapters-http";

import type { UiState, UiToolCall } from "./state.ts";
import {
  appendTranscriptItem,
  appendToolCallBlockToActiveTurn,
  markAssistantTextBoundary,
  removeTranscriptItem,
} from "./reducer-turns.ts";
import {
  appendUniqueString,
  isTerminalToolStatus,
  mergeToolPreview,
  recomputeToolCallDepths,
  removeToolCallAndReparent,
  upsertToolCall,
} from "./reducer-tool-calls.ts";

type ToolStartedEvent = Extract<RenderedFrontendEventEnvelope, { type: "tool_started" }>;
type ToolUpdatedEvent = Extract<RenderedFrontendEventEnvelope, { type: "tool_updated" }>;

export function reduceToolStartedEvent(state: UiState, event: ToolStartedEvent): UiState {
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

export function reduceToolUpdatedEvent(state: UiState, event: ToolUpdatedEvent): UiState {
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
