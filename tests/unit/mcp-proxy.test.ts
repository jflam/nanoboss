import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { writeCurrentSessionPointer } from "../../src/current-session.ts";
import { resolveSelfCommand } from "../../src/self-command.ts";
import { SessionStore } from "../../src/session-store.ts";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const path = tempDirs.pop();
    if (path) {
      rmSync(path, { recursive: true, force: true });
    }
  }
});

describe("static nanoboss MCP proxy", () => {
  test("serves tools/list and defaults to the current session for top_level_runs", async () => {
    const home = mkdtempSync(join(tmpdir(), "nanoboss-mcp-home-"));
    const rootDir = mkdtempSync(join(tmpdir(), "nanoboss-mcp-root-"));
    tempDirs.push(home, rootDir);

    const originalHome = process.env.HOME;
    process.env.HOME = home;

    const sessionId = `session-proxy-${crypto.randomUUID()}`;
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
      data: { verdict: "mixed" },
      display: "review display",
      summary: "review summary",
    });
    writeCurrentSessionPointer({
      sessionId,
      cwd: process.cwd(),
      rootDir,
    });

    const command = resolveSelfCommand("mcp", ["proxy"]);
    const child = spawn(command.command, command.args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: home,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const frames = new StdioFrameReader(child.stdout);

    try {
      writeMcpMessage(child.stdin, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: {
            name: "test-client",
            version: "0.0.0",
          },
        },
      });
      const initialize = await readMcpMessage(frames);
      expect(initialize.result?.serverInfo?.name).toBe("nanoboss");

      writeMcpMessage(child.stdin, {
        jsonrpc: "2.0",
        method: "notifications/initialized",
      });

      writeMcpMessage(child.stdin, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
      });
      const list = await readMcpMessage(frames);
      const toolNames = list.result?.tools?.map((tool) => tool.name) ?? [];
      expect(toolNames).toContain("procedure_list");
      expect(toolNames).toContain("top_level_runs");
      expect(toolNames).not.toContain("procedure_dispatch_start");
      expect(toolNames).not.toContain("procedure_dispatch_status");
      expect(toolNames).not.toContain("procedure_dispatch_wait");
      expect(toolNames).not.toContain("procedure_dispatch");

      writeMcpMessage(child.stdin, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "top_level_runs",
          arguments: {
            limit: 1,
          },
        },
      });
      const call = await readMcpMessage(frames);
      expect(call.result?.structuredContent?.items?.[0]).toMatchObject({
        cell: reviewCell.cell,
        procedure: "second-opinion",
        summary: "review summary",
      });

      writeMcpMessage(child.stdin, {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "procedure_dispatch_wait",
          arguments: {
            dispatchId: "dispatch_test",
          },
        },
      });
      const blocked = await readMcpMessage(frames);
      expect(blocked.error?.message).toContain("only available from the attached nanoboss-session MCP server");
    } finally {
      child.kill();
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
      });
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
  }, 30_000);
});

function writeMcpMessage(
  stdin: NodeJS.WritableStream,
  message: unknown,
): void {
  stdin.write(`${JSON.stringify(message)}\n`);
}

async function readMcpMessage(
  frames: StdioFrameReader,
): Promise<{
  result?: {
    serverInfo?: { name?: string };
    tools?: Array<{ name: string }>;
    structuredContent?: {
      items?: Array<{
        cell: { sessionId: string; cellId: string };
        procedure: string;
        summary?: string;
      }>;
    };
  };
  error?: {
    message?: string;
  };
}> {
  const body = await frames.read();
  return JSON.parse(body) as {
    result?: {
      serverInfo?: { name?: string };
      tools?: Array<{ name: string }>;
      structuredContent?: {
        items?: Array<{
          cell: { sessionId: string; cellId: string };
          procedure: string;
          summary?: string;
        }>;
      };
    };
    error?: {
      message?: string;
    };
  };
}

class StdioFrameReader {
  private buffer = Buffer.alloc(0);
  private readonly pending: Array<{
    resolve: (body: string) => void;
    reject: (error: unknown) => void;
  }> = [];

  constructor(stream: NodeJS.ReadableStream) {
    stream.on("data", (chunk: Buffer | string) => {
      this.buffer = Buffer.concat([this.buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      this.flush();
    });
    stream.on("error", (error) => {
      for (const waiter of this.pending.splice(0)) {
        waiter.reject(error);
      }
    });
  }

  read(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject });
      this.flush();
    });
  }

  private flush(): void {
    while (this.pending.length > 0) {
      const lineEnd = this.buffer.indexOf("\n");
      if (lineEnd < 0) {
        return;
      }

      const line = this.buffer.subarray(0, lineEnd).toString("utf8").replace(/\r$/, "");
      this.buffer = this.buffer.subarray(lineEnd + 1);
      if (line.length === 0) {
        continue;
      }

      this.pending.shift()?.resolve(line);
    }
  }
}
