import { describe, expect, test } from "bun:test";

import { formatMcpToolResult } from "../src/tool-result-format.ts";

describe("nanoboss MCP formatting", () => {
  test("wraps array results in an items record for structuredContent", () => {
    const formatted = formatMcpToolResult("list_runs", [
      { procedure: "review", summary: "done" },
    ]);

    expect(formatted.structuredContent).toEqual({
      items: [
        { procedure: "review", summary: "done" },
      ],
    });
  });

  test("preserves object results as structuredContent records", () => {
    const formatted = formatMcpToolResult("procedure_dispatch_start", {
      dispatchId: "dispatch_123",
      status: "queued",
    });

    expect(formatted.structuredContent).toEqual({
      dispatchId: "dispatch_123",
      status: "queued",
    });
  });

  test("serializes completed dispatch waits from the runtime result shape", () => {
    const formatted = formatMcpToolResult("procedure_dispatch_wait", {
      dispatchId: "dispatch_123",
      procedure: "review",
      status: "completed",
      result: {
        procedure: "review",
        run: {
          sessionId: "session_123",
          runId: "cell_123",
        },
        display: "review completed",
      },
    });

    expect(formatted.content).toEqual([
      {
        type: "text",
        text: "review completed",
      },
    ]);
    expect(formatted.structuredContent).toEqual({
      dispatchId: "dispatch_123",
      procedure: "review",
      status: "completed",
      result: {
        procedure: "review",
        run: {
          sessionId: "session_123",
          runId: "cell_123",
        },
        display: "review completed",
      },
    });
  });
});
