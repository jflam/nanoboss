import { describe, expect, test } from "bun:test";

import { parseSseStream } from "../src/sse-stream.ts";

describe("parseSseStream", () => {
  test("parses id, event, and multi-line data", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode([
          "id: 7",
          "event: text_delta",
          'data: {"seq":7,',
          'data: "type":"text_delta"}',
          "",
          "",
        ].join("\n")));
        controller.close();
      },
    });

    const messages: Array<{ id?: string; event?: string; data: string }> = [];
    await parseSseStream(stream, (message) => {
      messages.push(message);
    });

    expect(messages).toEqual([
      {
        id: "7",
        event: "text_delta",
        data: '{"seq":7,\n"type":"text_delta"}',
      },
    ]);
  });
});
