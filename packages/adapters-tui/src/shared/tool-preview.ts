import type { RenderedFrontendEventEnvelope } from "@nanoboss/adapters-http";

export type ToolPreviewBlock = NonNullable<
  | Extract<RenderedFrontendEventEnvelope, { type: "tool_started" }>["data"]["callPreview"]
  | Extract<RenderedFrontendEventEnvelope, { type: "tool_updated" }>["data"]["resultPreview"]
  | Extract<RenderedFrontendEventEnvelope, { type: "tool_updated" }>["data"]["errorPreview"]
>;
