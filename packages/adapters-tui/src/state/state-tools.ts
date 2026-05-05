import type { ToolPreviewBlock } from "../shared/tool-preview.ts";

export interface UiToolCall {
  id: string;
  runId: string;
  parentToolCallId?: string;
  transcriptVisible?: boolean;
  removeOnTerminal?: boolean;
  title: string;
  kind: string;
  toolName?: string;
  status: string;
  depth: number;
  isWrapper: boolean;
  callPreview?: ToolPreviewBlock;
  resultPreview?: ToolPreviewBlock;
  errorPreview?: ToolPreviewBlock;
  rawInput?: unknown;
  rawOutput?: unknown;
  durationMs?: number;
}
