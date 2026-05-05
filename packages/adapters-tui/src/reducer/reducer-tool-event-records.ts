import type { RenderedFrontendEventEnvelope } from "@nanoboss/adapters-http";

import type { UiToolCall } from "../state/state.ts";
import { mergeToolPreview } from "./reducer-tool-calls.ts";

export type ToolStartedEvent = Extract<RenderedFrontendEventEnvelope, { type: "tool_started" }>;
export type ToolUpdatedEvent = Extract<RenderedFrontendEventEnvelope, { type: "tool_updated" }>;

export function buildStartedToolCall(
  event: ToolStartedEvent,
  existing: UiToolCall | undefined,
): {
  toolCall: UiToolCall;
  transcriptVisible: boolean;
  removeOnTerminal: boolean;
} {
  const parentToolCallId = event.data.parentToolCallId ?? existing?.parentToolCallId;
  const transcriptVisible = event.data.transcriptVisible ?? existing?.transcriptVisible ?? true;
  const removeOnTerminal = event.data.removeOnTerminal ?? existing?.removeOnTerminal ?? false;
  const toolName = existing?.toolName ?? event.data.toolName;

  return {
    toolCall: {
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
    },
    transcriptVisible,
    removeOnTerminal,
  };
}

export function buildUpdatedToolCall(
  event: ToolUpdatedEvent,
  existing: UiToolCall | undefined,
): {
  toolCall: UiToolCall;
  transcriptVisible: boolean;
  removeOnTerminal: boolean;
} {
  const title = event.data.title ?? existing?.title ?? event.data.toolCallId;
  const parentToolCallId = event.data.parentToolCallId ?? existing?.parentToolCallId;
  const transcriptVisible = event.data.transcriptVisible ?? existing?.transcriptVisible ?? true;
  const removeOnTerminal = event.data.removeOnTerminal ?? existing?.removeOnTerminal ?? false;
  const toolName = existing?.toolName ?? event.data.toolName;

  return {
    toolCall: {
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
    },
    transcriptVisible,
    removeOnTerminal,
  };
}
