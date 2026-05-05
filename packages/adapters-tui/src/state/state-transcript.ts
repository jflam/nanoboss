import type { TurnDisplayBlock } from "@nanoboss/adapters-http";

export interface UiTurn {
  id: string;
  role: "user" | "assistant" | "system";
  markdown: string;
  /**
   * Structured block-list projection for assistant turns. Consumed by the
   * view layer to preserve text/tool_call boundaries without re-deriving
   * them from `markdown`. Kept in sync with `markdown` so existing code
   * paths that still reference `markdown` keep working during rollout.
   */
  blocks?: TurnDisplayBlock[];
  status?: "streaming" | "complete" | "failed" | "cancelled";
  runId?: string;
  displayStyle?: "inline" | "card";
  cardTone?: "info" | "success" | "warning" | "error";
  meta?: {
    procedure?: string;
    tokenUsageLine?: string;
    failureMessage?: string;
    completionNote?: string;
    statusMessage?: string;
  };
}

export type UiTranscriptItem =
  | { type: "turn"; id: string }
  | { type: "tool_call"; id: string }
  | { type: "procedure_panel"; id: string };
