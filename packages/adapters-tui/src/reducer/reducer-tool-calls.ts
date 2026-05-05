import type { UiToolCall } from "../state/state.ts";

export function mergeToolPreview(
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

export function upsertToolCall(toolCalls: UiToolCall[], nextToolCall: UiToolCall): UiToolCall[] {
  const existingIndex = toolCalls.findIndex((toolCall) => toolCall.id === nextToolCall.id);
  if (existingIndex < 0) {
    return [...toolCalls, nextToolCall];
  }

  return toolCalls.map((toolCall, index) => index === existingIndex ? nextToolCall : toolCall);
}

export function removeToolCallAndReparent(toolCalls: UiToolCall[], toolCallId: string): UiToolCall[] {
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

export function recomputeToolCallDepths(toolCalls: UiToolCall[]): UiToolCall[] {
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

export function appendUniqueString(values: string[], nextValue: string): string[] {
  return values.includes(nextValue) ? values : [...values, nextValue];
}

export function isTerminalToolStatus(status: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
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
