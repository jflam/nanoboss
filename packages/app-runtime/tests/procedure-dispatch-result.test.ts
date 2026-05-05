import { expect, test } from "bun:test";

import { extractProcedureDispatchResult } from "../src/procedure-dispatch-result.ts";

test("extracts async procedure dispatch results from copilot-style tool payloads", () => {
  const parsed = extractProcedureDispatchResult([
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "call_123",
      status: "completed",
      rawOutput: {
        content: '{"dispatchId":"dispatch_123","status":"completed","procedure":"research","result":{"run":{"sessionId":"s1","runId":"c1"},"display":"done"}}',
        detailedContent: '{"dispatchId":"dispatch_123","status":"completed","procedure":"research","result":{"run":{"sessionId":"s1","runId":"c1"},"display":"done"}}',
        contents: [
          {
            type: "text",
            text: '{"dispatchId":"dispatch_123","status":"completed","procedure":"research","result":{"run":{"sessionId":"s1","runId":"c1"},"display":"done"}}',
          },
        ],
      },
      content: [
        {
          type: "content",
          content: {
            type: "text",
            text: '{"dispatchId":"dispatch_123","status":"completed","procedure":"research","result":{"run":{"sessionId":"s1","runId":"c1"},"display":"done"}}',
          },
        },
      ],
    } as never,
  ]);

  expect(parsed).toEqual({
    run: { sessionId: "s1", runId: "c1" },
    display: "done",
  });
});
