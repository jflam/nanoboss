import { mkdtempSync, rmSync } from "node:fs";
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { ensureSessionMcpHttpServer, disposeSessionMcpHttpServer } from "../../src/session-mcp-http.ts";
import { SessionStore } from "../../src/session-store.ts";

const tempDirs: string[] = [];
const sessionIds: string[] = [];

afterEach(() => {
  while (sessionIds.length > 0) {
    const sessionId = sessionIds.pop();
    if (sessionId) {
      disposeSessionMcpHttpServer(sessionId);
    }
  }

  while (tempDirs.length > 0) {
    const path = tempDirs.pop();
    if (path) {
      rmSync(path, { recursive: true, force: true });
    }
  }
});

describe("session MCP HTTP transport", () => {
  test("serves tools/list and tools/call over loopback HTTP", async () => {
    const rootDir = mkdtempSync(join(process.cwd(), ".tmp-session-mcp-http-"));
    tempDirs.push(rootDir);

    const sessionId = `session-http-${crypto.randomUUID()}`;
    sessionIds.push(sessionId);

    const store = new SessionStore({
      sessionId,
      cwd: process.cwd(),
      rootDir,
    });

    const reviewCell = store.startCell({
      procedure: "second-opinion",
      input: "review the patch",
      kind: "top_level",
    });
    store.finalizeCell(reviewCell, {
      data: {
        verdict: "mixed",
      },
      display: "review display",
      summary: "review summary",
    });

    const server = ensureSessionMcpHttpServer({
      config: {
        provider: "copilot",
        command: "copilot",
        args: [],
        cwd: process.cwd(),
      },
      sessionId,
      cwd: process.cwd(),
      rootDir,
    });

    if (!("url" in server)) {
      throw new Error("Expected loopback HTTP MCP server");
    }

    const listResponse = await fetch(server.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      }),
    });
    expect(listResponse.ok).toBe(true);

    const listBodyRaw: unknown = await listResponse.json();
    const listBody = listBodyRaw as {
      result?: {
        tools?: Array<{ name: string }>;
      };
    };
    expect(listBody.result?.tools?.map((tool) => tool.name)).toContain("top_level_runs");
    expect(listBody.result?.tools?.map((tool) => tool.name)).not.toContain("cell_parent");

    const callResponse = await fetch(server.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "top_level_runs",
          arguments: {
            limit: 1,
          },
        },
      }),
    });
    expect(callResponse.ok).toBe(true);

    const callBodyRaw: unknown = await callResponse.json();
    const callBody = callBodyRaw as {
      result?: {
        structuredContent?: Array<{
          cell: { sessionId: string; cellId: string };
          procedure: string;
          kind: string;
          summary?: string;
          dataRef?: {
            cell: { sessionId: string; cellId: string };
            path: string;
          };
          displayRef?: {
            cell: { sessionId: string; cellId: string };
            path: string;
          };
          dataShape?: { verdict: string };
          createdAt?: string;
        }>;
      };
    };
    const topLevelRuns = callBody.result?.structuredContent;
    expect(topLevelRuns).toHaveLength(1);
    expect(topLevelRuns?.[0]).toMatchObject({
      cell: reviewCell.cell,
      procedure: "second-opinion",
      kind: "top_level",
      summary: "review summary",
      dataRef: {
        cell: reviewCell.cell,
        path: "output.data",
      },
      displayRef: {
        cell: reviewCell.cell,
        path: "output.display",
      },
      dataShape: {
        verdict: "mixed",
      },
    });
    expect(typeof topLevelRuns?.[0]?.createdAt).toBe("string");
  });
});
