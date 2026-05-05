import type * as acp from "@agentclientprotocol/sdk";

import type {
  KernelValue,
  RunResult,
} from "@nanoboss/procedure-sdk";

import type { SessionUpdateEmitter } from "./shared.ts";

export function shouldForwardNestedAgentUpdate(
  update: acp.SessionUpdate,
  streamText: boolean,
  isWrappedInToolCall: boolean,
  isStructuredOutput: boolean,
): boolean {
  if (update.sessionUpdate === "agent_message_chunk") {
    if (isStructuredOutput) {
      return false;
    }

    // When the nested agent run is wrapped in its own tool_call (fresh sessions),
    // always forward chunks so callers see the agent's commentary interleaved with
    // its tool calls. The `stream: false` flag in that case only suppresses the
    // persisted stream on the stored run record, not live UI visibility.
    // For default-session calls (no wrapper), `stream: false` continues to suppress
    // live chunks so typed-JSON responses don't leak into the transcript.
    return isWrappedInToolCall || streamText;
  }

  return (
    update.sessionUpdate === "tool_call" ||
    update.sessionUpdate === "tool_call_update" ||
    update.sessionUpdate === "usage_update"
  );
}

export function buildStructuredOutputToolOutput<T extends KernelValue>(
  result: Pick<RunResult<T>, "dataRef" | "run">,
): {
  expandedContent: string;
  resultPreview: {
    bodyLines: string[];
  };
} {
  const storageLine = describeStructuredOutputStorage(result);
  return {
    expandedContent: `Generated structured JSON.\n${capitalize(storageLine)}.`,
    resultPreview: {
      bodyLines: [
        "generated structured JSON",
        storageLine,
      ],
    },
  };
}

export function emitStructuredOutputProcedurePanel<T extends KernelValue>(
  emitter: SessionUpdateEmitter,
  procedure: string,
  result: Pick<RunResult<T>, "dataRef" | "run">,
): void {
  emitter.emitUiEvent?.({
    type: "procedure_panel",
    procedure,
    rendererId: "nb/card@1",
    severity: "info",
    dismissible: true,
    key: `structured-output:${result.run.runId}`,
    payload: {
      kind: "notification",
      title: "Structured output",
      markdown: `Generated structured JSON.\n\n${capitalize(describeStructuredOutputStorage(result))}.`,
    },
  });
}

export function withNestedToolCallMetadata(
  update: acp.SessionUpdate,
  parentToolCallId?: string,
): acp.SessionUpdate {
  if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") {
    return update;
  }

  const metadata = getNestedToolCallMetadata(update, parentToolCallId);
  if (!metadata) {
    return update;
  }

  return {
    ...update,
    _meta: mergeNanobossToolMeta(update._meta, metadata),
  };
}

function describeStructuredOutputStorage<T extends KernelValue>(
  result: Pick<RunResult<T>, "dataRef" | "run">,
): string {
  return result.dataRef
    ? `stored ref \`${result.dataRef.path}\``
    : `stored result in \`${result.run.runId}\``;
}

function capitalize(text: string): string {
  return text.length === 0 ? text : `${text[0]?.toUpperCase() ?? ""}${text.slice(1)}`;
}

function getNestedToolCallMetadata(
  update: Extract<acp.SessionUpdate, { sessionUpdate: "tool_call" | "tool_call_update" }>,
  parentToolCallId?: string,
): Record<string, unknown> | undefined {
  const existingNanobossMeta = getNanobossMeta(update._meta);
  const nextMetadata: Record<string, unknown> = {};

  if (parentToolCallId && typeof existingNanobossMeta?.parentToolCallId !== "string") {
    nextMetadata.parentToolCallId = parentToolCallId;
  }

  const title = typeof update.title === "string" ? update.title : undefined;
  if (
    title
    && isInternalProcedureDispatchToolTitle(title)
    && typeof existingNanobossMeta?.transcriptVisible !== "boolean"
  ) {
    nextMetadata.transcriptVisible = false;
  }

  if (
    title
    && isInternalProcedureDispatchToolTitle(title)
    && typeof existingNanobossMeta?.removeOnTerminal !== "boolean"
  ) {
    nextMetadata.removeOnTerminal = true;
  }

  return Object.keys(nextMetadata).length > 0 ? nextMetadata : undefined;
}

function isInternalProcedureDispatchToolTitle(title: string): boolean {
  return title.includes("procedure_dispatch_start") || title.includes("procedure_dispatch_wait");
}

function mergeNanobossToolMeta(
  meta: acp.SessionUpdate["_meta"],
  nanobossFields: Record<string, unknown>,
): NonNullable<acp.SessionUpdate["_meta"]> {
  const base = meta && typeof meta === "object" ? meta : {};
  const existingNanoboss = getNanobossMeta(base);
  return {
    ...base,
    nanoboss: {
      ...(existingNanoboss ?? {}),
      ...nanobossFields,
    },
  };
}

function getNanobossMeta(meta: unknown): Record<string, unknown> | undefined {
  if (!meta || typeof meta !== "object") {
    return undefined;
  }

  const nanoboss = "nanoboss" in meta ? meta.nanoboss : undefined;
  return nanoboss && typeof nanoboss === "object"
    ? nanoboss as Record<string, unknown>
    : undefined;
}
