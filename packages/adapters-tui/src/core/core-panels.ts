import typia from "typia";

import { jsonType, type UiCardKind, type TypeDescriptor } from "@nanoboss/procedure-sdk";

import { MessageCardComponent } from "../components/message-card.ts";
import type { Component } from "../shared/pi-tui.ts";
import type { PanelRenderer } from "./panel-renderers.ts";

/**
 * Payload shape accepted by the core nb/card@1 renderer. The kind is
 * intentionally widened to a string so third-party authors can coin new
 * kinds; the core renderer falls back to an "info" tone for anything it
 * does not recognize.
 */
export interface NbCardV1Payload {
  kind: UiCardKind | string;
  title?: string;
  markdown: string;
}

const NbCardV1PayloadType: TypeDescriptor<NbCardV1Payload> = jsonType<NbCardV1Payload>(
  typia.json.schema<NbCardV1Payload>(),
  typia.createValidate<NbCardV1Payload>(),
);

type NbCardTone = "info" | "success" | "warning" | "error";

export function nbCardV1Tone(kind: string): NbCardTone {
  switch (kind) {
    case "summary":
      return "success";
    case "checkpoint":
      return "warning";
    default:
      return "info";
  }
}

export function renderNbCardV1Markdown(payload: NbCardV1Payload): string {
  const title = payload.title ?? "";
  return [
    `## ${title}`,
    "",
    `_${payload.kind}_`,
    "",
    payload.markdown.trim(),
  ]
    .filter((line, index, lines) => line.length > 0 || index < lines.length - 1)
    .join("\n");
}

/**
 * Factory for the core nb/card@1 PanelRenderer. The renderer is no longer
 * registered at module-import time; it is contributed by the built-in
 * "nanoboss-core-ui" TUI extension during bootExtensions(). This keeps the
 * implementation in one place while still flowing through the extension
 * activation path so precedence rules (repo > profile > builtin) apply
 * uniformly to every renderer in the system.
 */
export function createNbCardV1Renderer(): PanelRenderer<NbCardV1Payload> {
  return {
    rendererId: "nb/card@1",
    schema: NbCardV1PayloadType,
    render({ payload, theme }): Component {
      const markdown = renderNbCardV1Markdown(payload);
      const lines = markdown.length === 0 ? ["…"] : markdown.split("\n");
      return new MessageCardComponent(theme, lines, nbCardV1Tone(payload.kind));
    },
  };
}
