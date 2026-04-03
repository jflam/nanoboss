import * as acp from "@agentclientprotocol/sdk";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";

interface StoredTurn {
  role: "user" | "assistant";
  text: string;
}

interface StoredSession {
  sessionId: string;
  turns: StoredTurn[];
}

interface LiveSession extends StoredSession {
  mcpServers?: acp.NewSessionRequest["mcpServers"];
}

interface InternalSlashDispatch {
  name: string;
  prompt: string;
}

const SUPPORT_LOAD_SESSION = process.env.MOCK_AGENT_SUPPORT_LOAD_SESSION === "1";
const SESSION_STORE_DIR = process.env.MOCK_AGENT_SESSION_STORE_DIR?.trim() || undefined;

class MockAgent implements acp.Agent {
  private readonly sessions = new Map<string, LiveSession>();

  constructor(private readonly connection: acp.AgentSideConnection) {}

  async initialize(_params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentInfo: {
        name: "mock-agent",
        version: "0.1.0",
      },
      agentCapabilities: {
        loadSession: SUPPORT_LOAD_SESSION,
      },
    };
  }

  async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    const session: LiveSession = {
      sessionId: crypto.randomUUID(),
      turns: [],
      mcpServers: params.mcpServers,
    };

    this.sessions.set(session.sessionId, session);
    persistSession(session);

    return {
      sessionId: session.sessionId,
    };
  }

  async loadSession(params: acp.LoadSessionRequest): Promise<acp.LoadSessionResponse> {
    if (!SUPPORT_LOAD_SESSION) {
      throw new Error("session/load unsupported");
    }

    const stored = readPersistedSession(params.sessionId);
    if (!stored) {
      throw new Error(`Unknown session: ${params.sessionId}`);
    }

    const session: LiveSession = {
      ...stored,
      mcpServers: "mcpServers" in params ? params.mcpServers : undefined,
    };

    this.sessions.set(session.sessionId, session);
    return {};
  }

  async authenticate(_params: acp.AuthenticateRequest): Promise<acp.AuthenticateResponse> {
    return {};
  }

  async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
    const session = this.getSession(params.sessionId);
    const prompt = params.prompt
      .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
      .map((block) => block.text)
      .join("\n");

    let text: string;
    try {
      text = await answerForPrompt(prompt, session, this.connection, params.sessionId);
    } catch (error) {
      text = `mock-agent-error:${error instanceof Error ? error.message : String(error)}`;
    }
    session.turns.push({ role: "user", text: prompt });
    session.turns.push({ role: "assistant", text });
    persistSession(session);

    if (prompt.toLowerCase().includes("nested tool trace demo")) {
      const toolCallId = crypto.randomUUID();
      await this.connection.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId,
          title: "Mock read README.md",
          kind: "read",
          status: "in_progress",
          rawInput: {
            path: "README.md",
          },
        },
      });
      await this.connection.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: "completed",
          rawOutput: {
            path: "README.md",
          },
        },
      });
    }

    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "usage_update",
        size: 8192,
        used: 512,
      },
    });

    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text,
        },
      },
    });

    return { stopReason: "end_turn" };
  }

  async cancel(_params: acp.CancelNotification): Promise<void> {
    // no-op
  }

  private getSession(sessionId: string): LiveSession {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      return existing;
    }

    const stored = readPersistedSession(sessionId);
    if (!stored) {
      throw new Error(`Unknown session: ${sessionId}`);
    }

    const session: LiveSession = {
      ...stored,
    };
    this.sessions.set(sessionId, session);
    return session;
  }
}

async function answerForPrompt(
  prompt: string,
  session: LiveSession,
  connection: acp.AgentSideConnection,
  sessionId: string,
): Promise<string> {
  const dispatch = parseInternalSlashDispatch(prompt);
  if (dispatch) {
    const result = await callProcedureDispatch(session, connection, sessionId, dispatch);
    return extractToolResultText(result);
  }

  const normalized = prompt.toLowerCase();

  if (normalized.includes("simulate-long-run")) {
    await Bun.sleep(3_500);
  }

  if (normalized.includes("what is 2+2") || normalized.includes("what is 2 + 2")) {
    return "4";
  }

  const addMatch = normalized.match(/add\s+(-?\d+(?:\.\d+)?)\s+to\s+result/);
  if (addMatch) {
    const increment = Number(addMatch[1]);
    const previous = lastAssistantNumber(session);
    if (previous === undefined || !Number.isFinite(increment)) {
      return "no prior result";
    }

    return String(previous + increment);
  }

  if (normalized.includes("first 3 prime numbers")) {
    return "2\n3\n5";
  }

  if (normalized.includes("markdown demo")) {
    return [
      "# Demo",
      "",
      "- one",
      "- two",
      "",
      "```ts",
      "const x = 1",
      "```",
      "",
    ].join("\n");
  }

  if (normalized.includes("nested tool trace demo")) {
    return "hidden nested output";
  }

  return `mock:${prompt.trim()}`;
}

function parseInternalSlashDispatch(prompt: string): InternalSlashDispatch | undefined {
  if (!prompt.includes("Nanoboss internal slash-command dispatch.")) {
    return undefined;
  }

  const jsonBlock = prompt
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .find((block) => block.startsWith("{") && block.endsWith("}"));
  if (!jsonBlock) {
    return undefined;
  }

  const parsed = JSON.parse(jsonBlock) as { name?: unknown; prompt?: unknown };
  if (typeof parsed.name !== "string" || typeof parsed.prompt !== "string") {
    return undefined;
  }

  return {
    name: parsed.name,
    prompt: parsed.prompt,
  };
}

async function callProcedureDispatch(
  session: LiveSession,
  connection: acp.AgentSideConnection,
  sessionId: string,
  dispatch: InternalSlashDispatch,
): Promise<unknown> {
  const server = session.mcpServers?.find((candidate) => candidate.name === "nanoboss-session");
  if (!server || server.type !== "stdio") {
    throw new Error("Missing stdio nanoboss-session MCP server");
  }

  const toolCallId = crypto.randomUUID();
  await connection.sessionUpdate({
    sessionId,
    update: {
      sessionUpdate: "tool_call",
      toolCallId,
      title: "procedure_dispatch",
      kind: "other",
      status: "pending",
      rawInput: dispatch,
    },
  });

  try {
    const result = await callStdioMcpTool(server, "procedure_dispatch", dispatch);
    await connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "completed",
        rawOutput: result,
      },
    });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "failed",
        rawOutput: { error: message },
      },
    });
    throw error;
  }
}

async function callStdioMcpTool(
  server: Extract<acp.NewSessionRequest["mcpServers"][number], { type: "stdio" }>,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const child = spawn(server.command, server.args ?? [], {
    env: process.env,
    stdio: ["pipe", "pipe", "inherit"],
  });

  const rl = createInterface({ input: child.stdout });
  let nextId = 1;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const rejectPending = (error: Error) => {
    for (const waiter of pending.values()) {
      waiter.reject(error);
    }
    pending.clear();
  };

  child.once("error", (error) => {
    rejectPending(error instanceof Error ? error : new Error(String(error)));
  });
  child.once("exit", (code, signal) => {
    if (pending.size === 0) {
      return;
    }

    rejectPending(new Error(`session-mcp exited before responding (code=${String(code)} signal=${String(signal)})`));
  });

  rl.on("line", (line) => {
    if (!line.trim()) {
      return;
    }

    const message = JSON.parse(line) as {
      id?: number;
      result?: unknown;
      error?: { message?: string };
    };
    if (typeof message.id !== "number") {
      return;
    }

    const waiter = pending.get(message.id);
    if (!waiter) {
      return;
    }

    pending.delete(message.id);
    if (message.error) {
      waiter.reject(new Error(message.error.message || "MCP call failed"));
      return;
    }

    waiter.resolve(message.result);
  });

  const call = (method: string, params?: unknown) => {
    const id = nextId;
    nextId += 1;

    const promise = new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });

    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return Promise.race([
      promise,
      Bun.sleep(10_000).then(() => {
        throw new Error(`Timed out waiting for session-mcp ${method}`);
      }),
    ]);
  };

  try {
    await call("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: {
        name: "mock-agent",
        version: "0.0.0",
      },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

    const result = await call("tools/call", {
      name: toolName,
      arguments: args,
    });

    return result;
  } finally {
    rl.close();
    child.kill();
  }
}

function extractToolResultText(result: unknown): string {
  if (!result || typeof result !== "object") {
    return "tool completed";
  }

  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  const firstText = content?.find((item) => item.type === "text" && typeof item.text === "string")?.text;
  return firstText ?? "tool completed";
}

function lastAssistantNumber(session: StoredSession): number | undefined {
  for (let index = session.turns.length - 1; index >= 0; index -= 1) {
    const turn = session.turns[index];
    if (!turn || turn.role !== "assistant") {
      continue;
    }

    const value = Number(turn.text.trim());
    if (Number.isFinite(value)) {
      return value;
    }
  }

  return undefined;
}

function persistSession(session: StoredSession): void {
  const filePath = getSessionFilePath(session.sessionId);
  if (!filePath) {
    return;
  }

  mkdirSync(SESSION_STORE_DIR!, { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(session, null, 2)}\n`, "utf8");
}

function readPersistedSession(sessionId: string): StoredSession | undefined {
  const filePath = getSessionFilePath(sessionId);
  if (!filePath || !existsSync(filePath)) {
    return undefined;
  }

  return JSON.parse(readFileSync(filePath, "utf8")) as StoredSession;
}

function getSessionFilePath(sessionId: string): string | undefined {
  if (!SESSION_STORE_DIR) {
    return undefined;
  }

  return join(SESSION_STORE_DIR, `${sessionId}.json`);
}

const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin),
);
const connection = new acp.AgentSideConnection(
  (connection) => new MockAgent(connection),
  stream,
);
await connection.closed;
