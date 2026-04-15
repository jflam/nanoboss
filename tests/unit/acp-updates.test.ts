import { describe, expect, test } from "bun:test";

import { collectTextSessionUpdates, parseAssistantNoticeText } from "@nanoboss/agent-acp";

describe("acp-updates", () => {
  test("recognizes assistant notices", () => {
    expect(parseAssistantNoticeText("Info: Operation cancelled by user\n")).toEqual({
      tone: "info",
      text: "Operation cancelled by user",
    });
    expect(parseAssistantNoticeText("normal response")).toBeUndefined();
  });

  test("omits assistant notices and ui markers from collected raw text", () => {
    expect(collectTextSessionUpdates([
      {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "First sentence. ",
        },
      },
      {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "Info: Operation cancelled by user",
        },
      },
      {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: '[[nanoboss-ui]] {"type":"status","procedure":"research","message":"Gathering sources"}\n',
        },
      },
      {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "Second sentence.",
        },
      },
    ])).toBe("First sentence. Second sentence.");
  });
});
