import type { UiState } from "../state/state.ts";
import {
  appendToolCallBlockToActiveTurn,
  markAssistantTextBoundary,
} from "./reducer-turns.ts";
import {
  appendTranscriptItem,
  removeTranscriptItem,
} from "./reducer-transcript-items.ts";
import {
  appendUniqueString,
  isTerminalToolStatus,
  recomputeToolCallDepths,
  removeToolCallAndReparent,
  upsertToolCall,
} from "./reducer-tool-calls.ts";
import {
  buildStartedToolCall,
  buildUpdatedToolCall,
  type ToolStartedEvent,
  type ToolUpdatedEvent,
} from "./reducer-tool-event-records.ts";

export function reduceToolStartedEvent(state: UiState, event: ToolStartedEvent): UiState {
  const existing = state.toolCalls.find((toolCall) => toolCall.id === event.data.toolCallId);
  const activeRunAttemptedToolCallIds = state.activeRunId === event.data.runId
    ? appendUniqueString(state.activeRunAttemptedToolCallIds, event.data.toolCallId)
    : state.activeRunAttemptedToolCallIds;

  if (!state.showToolCalls) {
    return {
      ...state,
      activeRunAttemptedToolCallIds,
    };
  }

  const { toolCall: nextToolCall, transcriptVisible } = buildStartedToolCall(event, existing);

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
  const activeRunSucceededToolCallIds = state.activeRunId === event.data.runId && event.data.status === "completed"
    ? appendUniqueString(state.activeRunSucceededToolCallIds, event.data.toolCallId)
    : state.activeRunSucceededToolCallIds;

  if (!state.showToolCalls) {
    return {
      ...state,
      activeRunSucceededToolCallIds,
    };
  }

  const { toolCall: nextToolCall, transcriptVisible, removeOnTerminal } = buildUpdatedToolCall(
    event,
    existing,
  );

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
