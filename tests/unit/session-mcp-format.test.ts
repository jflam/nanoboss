import { describe, expect, test } from "bun:test";

import { formatSessionMcpToolResult } from "../../src/session-mcp.ts";

describe("session MCP formatting", () => {
  test("wraps array results in an items record for structuredContent", () => {
    const formatted = formatSessionMcpToolResult("top_level_runs", [
      { procedure: "review", summary: "done" },
    ]);

    expect(formatted.structuredContent).toEqual({
      items: [
        { procedure: "review", summary: "done" },
      ],
    });
  });

  test("preserves object results as structuredContent records", () => {
    const formatted = formatSessionMcpToolResult("procedure_dispatch_start", {
      dispatchId: "dispatch_123",
      status: "queued",
    });

    expect(formatted.structuredContent).toEqual({
      dispatchId: "dispatch_123",
      status: "queued",
    });
  });
});
