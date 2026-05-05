import typia from "typia";

import { jsonType } from "@nanoboss/procedure-sdk";

import { MessageCardComponent } from "../components/message-card.ts";
import type { Component } from "../shared/pi-tui.ts";
import { registerPanelRenderer } from "./panel-renderers.ts";

/**
 * Error panel payload rendered for run_failed procedure panels so resume
 * errors remain visible regardless of the tool-card toggle.
 */
interface NbErrorV1Payload {
  procedure: string;
  message: string;
}

const NbErrorV1PayloadType = jsonType<NbErrorV1Payload>(
  typia.json.schema<NbErrorV1Payload>(),
  typia.createValidate<NbErrorV1Payload>(),
);

registerPanelRenderer<NbErrorV1Payload>({
  rendererId: "nb/error@1",
  schema: NbErrorV1PayloadType,
  render({ payload, theme }): Component {
    const lines = [
      `/${payload.procedure}`,
      "",
      `Error: ${payload.message}`,
    ];
    return new MessageCardComponent(theme, lines, "error");
  },
});

interface NbNoticeV1Payload {
  message: string;
  severity: "info" | "warn" | "error";
}

const NbNoticeV1PayloadType = jsonType<NbNoticeV1Payload>(
  typia.json.schema<NbNoticeV1Payload>(),
  typia.createValidate<NbNoticeV1Payload>(),
);

registerPanelRenderer<NbNoticeV1Payload>({
  rendererId: "nb/notice@1",
  schema: NbNoticeV1PayloadType,
  render({ payload, theme }): Component {
    const tone = payload.severity === "warn"
      ? "warning"
      : payload.severity;
    const lines = payload.message.length === 0 ? ["…"] : payload.message.split("\n");
    return new MessageCardComponent(theme, lines, tone);
  },
});
