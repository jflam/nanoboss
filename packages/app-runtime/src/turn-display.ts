import type { PersistedRuntimeEvent } from "./runtime-events.ts";

/**
 * Structured block list derived from a run's persisted event stream.
 *
 * Replaces the previously flat `output.display` string so that consumers can
 * preserve the authoring boundaries between assistant text and tool calls and
 * avoid double-rendering the final chunk when the same stream has already
 * been rendered live.
 */
export type TurnDisplayBlock =
  | {
      kind: "text";
      text: string;
      origin: "stream" | "replay";
    }
  | {
      kind: "tool_call";
      toolCallId: string;
    };

export interface TurnDisplay {
  blocks: TurnDisplayBlock[];
}

/**
 * Project a persisted runtime event stream into a structured TurnDisplay.
 *
 * - Consecutive `text_delta` events with no intervening tool event coalesce
 *   into a single text block.
 * - A `tool_started` event introduces a `tool_call` boundary block.
 * - `tool_updated` events for an already-introduced tool are merged into the
 *   existing `tool_call` block (no duplicate block is emitted).
 * - Other event types are ignored for projection purposes; callers can still
 *   rely on `replayEvents` as the source of truth.
 */
export function buildTurnDisplay(
  events: Iterable<Pick<PersistedRuntimeEvent, "type"> & Record<string, unknown>>,
  options: { origin?: "stream" | "replay" } = {},
): TurnDisplay {
  const origin = options.origin ?? "replay";
  const blocks: TurnDisplayBlock[] = [];
  const seenToolCallIds = new Set<string>();

  for (const event of events) {
    if (event.type === "text_delta") {
      const text = typeof event.text === "string" ? event.text : "";
      if (text.length === 0) {
        continue;
      }
      const last = blocks[blocks.length - 1];
      if (last && last.kind === "text" && last.origin === origin) {
        last.text = `${last.text}${text}`;
      } else {
        blocks.push({ kind: "text", text, origin });
      }
      continue;
    }

    if (event.type === "tool_started") {
      const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : "";
      if (!toolCallId || seenToolCallIds.has(toolCallId)) {
        continue;
      }
      seenToolCallIds.add(toolCallId);
      blocks.push({ kind: "tool_call", toolCallId });
      continue;
    }

    // tool_updated, token_usage, run_completed, etc. do not introduce new
    // blocks — but a tool_updated referencing a not-yet-seen toolCallId
    // still warrants a boundary so that text chunks that follow don't
    // merge with text chunks that preceded the tool call.
    if (event.type === "tool_updated") {
      const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : "";
      if (toolCallId && !seenToolCallIds.has(toolCallId)) {
        seenToolCallIds.add(toolCallId);
        blocks.push({ kind: "tool_call", toolCallId });
      }
    }
  }

  return { blocks };
}
