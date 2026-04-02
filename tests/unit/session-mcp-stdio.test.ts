import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

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

describe("session MCP stdio transport", () => {
  test("serves tools/list and tools/call over stdio", async () => {
    const rootDir = mkdtempSync(join(process.cwd(), ".tmp-session-mcp-stdio-"));
    tempDirs.push(rootDir);

    const sessionId = `session-stdio-${crypto.randomUUID()}`;
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

    const command = resolveSelfCommand("session-mcp", [
      "--session-id",
      sessionId,
      "--cwd",
      process.cwd(),
      "--root-dir",
      rootDir,
    ]);
    const child = spawn(command.command, command.args, {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const frames = new StdioFrameReader(child.stdout);

    const stderrChunks: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

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
      expect(initialize.result?.serverInfo?.name).toBe("nanoboss-session");

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
      expect(toolNames).toContain("top_level_runs");
      expect(toolNames).not.toContain("cell_parent");

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
      const topLevelRuns = call.result?.structuredContent;
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
    } finally {
      child.kill();
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
      });
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      expect(stderr).toBe("");
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
    }>;
  };
}> {
  const body = await frames.readFrame();
  return JSON.parse(body) as {
    result?: {
      serverInfo?: { name?: string };
      tools?: Array<{ name: string }>;
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
      }>;
    };
  };
}

class StdioFrameReader {
  private buffer = Buffer.alloc(0);
  private readonly stdout: NodeJS.ReadableStream;

  constructor(stdout: NodeJS.ReadableStream) {
    this.stdout = stdout;
  }

  async readFrame(): Promise<string> {
    for (;;) {
      const body = this.tryReadFrame();
      if (body !== undefined) {
        return body;
      }

      const chunk = await this.readChunk();
      this.buffer = Buffer.concat([
        this.buffer,
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
      ]);
    }
  }

  private async readChunk(): Promise<Buffer | string> {
    return await new Promise<Buffer | string>((resolve, reject) => {
      const onData = (chunk: Buffer | string) => {
        cleanup();
        resolve(chunk);
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onEnd = () => {
        cleanup();
        reject(new Error("MCP stdio stream ended before a full JSON-RPC line was received"));
      };
      const cleanup = () => {
        this.stdout.off("data", onData);
        this.stdout.off("error", onError);
        this.stdout.off("end", onEnd);
        this.stdout.off("close", onEnd);
      };

      this.stdout.on("data", onData);
      this.stdout.once("error", onError);
      this.stdout.once("end", onEnd);
      this.stdout.once("close", onEnd);
    });
  }

  private tryReadFrame(): string | undefined {
    const lineEnd = this.buffer.indexOf("\n");
    if (lineEnd < 0) {
      return undefined;
    }

    const line = this.buffer.subarray(0, lineEnd).toString("utf8").replace(/\r$/, "");
    this.buffer = this.buffer.subarray(lineEnd + 1);
    return line.length > 0 ? line : this.tryReadFrame();
  }
}
