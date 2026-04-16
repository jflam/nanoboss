import { describe, expect, test } from "bun:test";

import {
  createProcedureUiMarkerStream,
  parseProcedureUiMarker,
  PROCEDURE_UI_MARKER_PREFIX,
  renderProcedureUiMarker,
  toProcedureUiSessionUpdate,
} from "@nanoboss/procedure-engine";

describe("ui-cli", () => {
  test("renders and parses procedure ui markers", () => {
    const statusMarker = renderProcedureUiMarker({
      type: "status",
      procedure: "research",
      phase: "collect",
      message: "Gathering sources",
      iteration: "2/3",
      waiting: true,
    });

    expect(statusMarker.startsWith(PROCEDURE_UI_MARKER_PREFIX)).toBe(true);
    expect(parseProcedureUiMarker(statusMarker)).toEqual({
      type: "status",
      procedure: "research",
      phase: "collect",
      message: "Gathering sources",
      iteration: "2/3",
      waiting: true,
    });

    const cardMarker = renderProcedureUiMarker({
      type: "card",
      procedure: "review",
      kind: "report",
      title: "Checkpoint",
      markdown: "- cited source",
    });

    expect(parseProcedureUiMarker(cardMarker)).toEqual({
      type: "card",
      procedure: "review",
      kind: "report",
      title: "Checkpoint",
      markdown: "- cited source",
    });
  });

  test("converts procedure ui events into agent text chunks and marker streams", () => {
    const update = toProcedureUiSessionUpdate({
      type: "status",
      procedure: "research",
      message: "Gathering sources",
    });

    expect(update).toEqual({
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: '[[nanoboss-ui]] {"type":"status","procedure":"research","message":"Gathering sources"}\n',
      },
    });

    if (update.sessionUpdate !== "agent_message_chunk" || update.content.type !== "text") {
      throw new Error("Expected an agent text chunk update");
    }

    const seen: unknown[] = [];
    const stream = createProcedureUiMarkerStream({
      onMarker(marker) {
        seen.push(marker);
      },
    });

    expect(stream.consume(`${update.content.text}plain output\n`)).toBe("plain output\n");
    expect(seen).toEqual([
      {
        type: "status",
        procedure: "research",
        message: "Gathering sources",
      },
    ]);
  });
});
