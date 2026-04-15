import * as acp from "@agentclientprotocol/sdk";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import type { McpServerStdioConfig } from "@nanoboss/adapters-mcp";

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

interface InternalSlashDispatch extends Record<string, unknown> {
  sessionId?: string;
  name: string;
  prompt: string;
  defaultAgentSelection?: {
    provider: "claude" | "gemini" | "codex" | "copilot";
    model?: string;
  };
  dispatchCorrelationId?: string;
}

const SUPPORT_LOAD_SESSION = process.env.MOCK_AGENT_SUPPORT_LOAD_SESSION === "1";
const SESSION_STORE_DIR = process.env.MOCK_AGENT_SESSION_STORE_DIR?.trim() || undefined;
const PROCEDURE_DISPATCH_TIMEOUT_MS = Number(process.env.MOCK_AGENT_PROCEDURE_DISPATCH_TIMEOUT_MS ?? "0");
const KEEP_MCP_RUNNING_ON_TIMEOUT = process.env.MOCK_AGENT_KEEP_MCP_RUNNING_ON_TIMEOUT === "1";
const STREAM_ASYNC_DISPATCH_PROGRESS = process.env.MOCK_AGENT_STREAM_ASYNC_DISPATCH_PROGRESS === "1";
const STRIP_ASYNC_WAIT_RAW_OUTPUT = process.env.MOCK_AGENT_STRIP_ASYNC_WAIT_RAW_OUTPUT === "1";
const COOPERATIVE_CANCEL = process.env.MOCK_AGENT_COOPERATIVE_CANCEL === "1";
const WRITE_COPILOT_LOG = process.env.MOCK_AGENT_WRITE_COPILOT_LOG === "1";
const LATE_PREVIOUS_TURN_CHUNK_MS = Number(process.env.MOCK_AGENT_LATE_PREVIOUS_TURN_CHUNK_MS ?? "0");

class MockAgent implements acp.Agent {
  private readonly sessions = new Map<string, LiveSession>();
  private readonly cancelledSessions = new Set<string>();

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
      text = await answerForPrompt(prompt, session, this.connection, params.sessionId, this.cancelledSessions);
    } catch (error) {
      if (error instanceof Error && error.message === "mock-agent-cooperative-cancelled") {
        throw error;
      }
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
      writeMockCopilotTelemetryLog(params.sessionId);
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

    if (LATE_PREVIOUS_TURN_CHUNK_MS > 0 && prompt.toLowerCase().includes("what is 2+2")) {
      setTimeout(() => {
        void this.connection.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: "[late previous turn chunk]",
            },
          },
        });
      }, LATE_PREVIOUS_TURN_CHUNK_MS);
    }

    return { stopReason: "end_turn" };
  }

  async cancel(params: acp.CancelNotification): Promise<void> {
    this.cancelledSessions.add(params.sessionId);
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
  cancelledSessions: Set<string>,
): Promise<string> {
  const dispatch = parseInternalSlashDispatch(prompt);
  if (dispatch) {
    const result = await callProcedureDispatchAsync(session, connection, sessionId, dispatch);
    return extractToolResultText(result);
  }

  const normalized = prompt.toLowerCase();

  if (normalized.includes("simulate-long-run")) {
    await Bun.sleep(3_500);
  }

  if (COOPERATIVE_CANCEL && normalized.includes("cooperative cancel demo")) {
    while (!cancelledSessions.has(sessionId)) {
      await Bun.sleep(25);
    }

    cancelledSessions.delete(sessionId);
    throw new Error("mock-agent-cooperative-cancelled");
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

function writeMockCopilotTelemetryLog(sessionId: string): void {
  if (!WRITE_COPILOT_LOG) {
    return;
  }

  const createdAt = new Date().toISOString();
  const dir = join(process.env.HOME?.trim() || homedir(), ".copilot", "logs");
  mkdirSync(dir, { recursive: true });

  writeFileSync(
    join(dir, `process-${Date.now()}-${process.pid}.log`),
    [
      `${createdAt} [INFO] [Telemetry] cli.telemetry:`,
      JSON.stringify({
        kind: "session_usage_info",
        created_at: createdAt,
        session_id: sessionId,
        metrics: {
          token_limit: 272000,
          current_tokens: 24152,
          messages_length: 4,
          system_tokens: 8011,
          conversation_tokens: 2178,
          tool_definitions_tokens: 13963,
        },
      }, null, 2),
      `${createdAt} [INFO] [Telemetry] cli.telemetry:`,
      JSON.stringify({
        kind: "assistant_usage",
        created_at: createdAt,
        session_id: sessionId,
        metrics: {
          input_tokens: 20964,
          input_tokens_uncached: 19428,
          output_tokens: 92,
          cache_read_tokens: 1536,
          cache_write_tokens: 0,
        },
      }, null, 2),
    ].join("\n"),
    "utf8",
  );
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

  const parsed = JSON.parse(jsonBlock) as {
    sessionId?: unknown;
    name?: unknown;
    prompt?: unknown;
    defaultAgentSelection?: unknown;
    dispatchCorrelationId?: unknown;
  };
  if (typeof parsed.name !== "string" || typeof parsed.prompt !== "string") {
    return undefined;
  }

  const selection = parsed.defaultAgentSelection;
  const provider = selection && typeof selection === "object"
    ? (selection as { provider?: unknown }).provider
    : undefined;
  const model = selection && typeof selection === "object"
    ? (selection as { model?: unknown }).model
    : undefined;

  return {
    sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : undefined,
    name: parsed.name,
    prompt: parsed.prompt,
    defaultAgentSelection: provider === "claude" || provider === "gemini" || provider === "codex" || provider === "copilot"
      ? { provider, ...(typeof model === "string" ? { model } : {}) }
      : undefined,
    dispatchCorrelationId: typeof parsed.dispatchCorrelationId === "string" ? parsed.dispatchCorrelationId : undefined,
  };
}

async function callProcedureDispatchAsync(
  session: LiveSession,
  connection: acp.AgentSideConnection,
  sessionId: string,
  dispatch: InternalSlashDispatch,
): Promise<unknown> {
  const server = findNanobossMcpServer(session);
  if (!server) {
    throw new Error("nanoboss MCP tools are not available in this session.");
  }
  if (STREAM_ASYNC_DISPATCH_PROGRESS) {
    await emitAssistantChunk(
      connection,
      sessionId,
      "Running the dispatch through the global nanoboss MCP implementation and waiting on the final procedure result.",
    );
  }

  const startResult = await callNamedProcedureDispatchTool(connection, sessionId, server, {
    name: "procedure_dispatch_start",
    args: dispatch,
  });

  const dispatchId = extractDispatchId(startResult);
  if (!dispatchId) {
    throw new Error("Missing dispatch id from procedure_dispatch_start");
  }

  for (let attempt = 0; attempt < 200; attempt += 1) {
    const waitResult = await callNamedProcedureDispatchTool(connection, sessionId, server, {
      name: "procedure_dispatch_wait",
      args: {
        dispatchId,
        waitMs: getProcedureDispatchWaitMs(),
      },
    });

    const status = extractDispatchStatus(waitResult);
    if (status === "completed") {
      return waitResult;
    }

    if (STREAM_ASYNC_DISPATCH_PROGRESS && attempt === 0) {
      await emitAssistantChunk(
        connection,
        sessionId,
        "The dispatch is still running; I’m just waiting on the final procedure output now.",
      );
    }

    if (status === "failed" || status === "cancelled") {
      throw new Error(extractDispatchError(waitResult) ?? `procedure dispatch ${status}`);
    }
  }

  throw new Error(`procedure dispatch did not complete: ${dispatchId}`);
}

async function callNamedProcedureDispatchTool(
  connection: acp.AgentSideConnection,
  sessionId: string,
  server: McpServerStdioConfig,
  params: {
    name: string;
    args: Record<string, unknown>;
  },
): Promise<unknown> {
  const toolCallId = crypto.randomUUID();
  await connection.sessionUpdate({
    sessionId,
    update: {
      sessionUpdate: "tool_call",
      toolCallId,
      title: params.name,
      kind: "other",
      status: "pending",
      rawInput: params.args,
    },
  });

  try {
    const result = await callStdioMcpTool(server, params.name, params.args, {
      timeoutMs: PROCEDURE_DISPATCH_TIMEOUT_MS > 0 ? PROCEDURE_DISPATCH_TIMEOUT_MS : undefined,
      keepAliveOnTimeout: KEEP_MCP_RUNNING_ON_TIMEOUT,
    });
    await connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "completed",
        rawOutput: STRIP_ASYNC_WAIT_RAW_OUTPUT && params.name === "procedure_dispatch_wait" ? undefined : result,
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

async function emitAssistantChunk(
  connection: acp.AgentSideConnection,
  sessionId: string,
  text: string,
): Promise<void> {
  await connection.sessionUpdate({
    sessionId,
    update: {
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text,
      },
    },
  });
}

async function callStdioMcpTool(
  server: McpServerStdioConfig,
  toolName: string,
  args: Record<string, unknown>,
  options: {
    timeoutMs?: number;
    keepAliveOnTimeout?: boolean;
  } = {},
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
  child.once("exit", (_code, _signal) => {
    // Allow the per-call timeout below to report missing responses. Some fast
    // one-shot nanoboss mcp invocations can exit before readline has drained the
    // final JSON-RPC response line.
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

  let preserveChild = false;

  const call = (method: string, params?: unknown, timeoutMs = 10_000) => {
    const id = nextId;
    nextId += 1;

    const promise = new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });

    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return Promise.race([
      promise,
      Bun.sleep(timeoutMs).then(() => {
        pending.delete(id);
        if (options.keepAliveOnTimeout) {
          preserveChild = true;
        }
        throw new Error(`Request timed out waiting for nanoboss-mcp ${method}`);
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
    }, options.timeoutMs ?? 10_000);

    return result;
  } finally {
    if (!preserveChild) {
      rl.close();
      child.kill();
    } else {
      setTimeout(() => {
      rl.close();
      child.kill();
      }, 30_000).unref?.();
    }
  }
}

function findNanobossMcpServer(
  session: LiveSession,
): McpServerStdioConfig | undefined {
  return session.mcpServers?.find(isNanobossStdioServer);
}

function isNanobossStdioServer(server: unknown): server is McpServerStdioConfig {
  return (
    typeof server === "object"
    && server !== null
    && "type" in server
    && server.type === "stdio"
    && "name" in server
    && typeof server.name === "string"
    && server.name.toLowerCase() === "nanoboss"
    && "command" in server
    && typeof server.command === "string"
    && "args" in server
    && Array.isArray(server.args)
    && "env" in server
    && Array.isArray(server.env)
  );
}

function extractDispatchId(value: unknown): string | undefined {
  return extractDispatchField(value, "dispatchId");
}

function extractDispatchStatus(value: unknown): string | undefined {
  return extractDispatchField(value, "status");
}

function extractDispatchError(value: unknown): string | undefined {
  return extractDispatchField(value, "error");
}

function extractDispatchField(value: unknown, field: "dispatchId" | "status" | "error"): string | undefined {
  if (typeof value === "string") {
    try {
      return extractDispatchField(JSON.parse(value) as unknown, field);
    } catch {
      return undefined;
    }
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const extracted = extractDispatchField(item, field);
      if (extracted) {
        return extracted;
      }
    }
    return undefined;
  }

  if (!value || typeof value !== "object") {
    return undefined;
  }

  const direct = (value as Record<string, unknown>)[field];
  if (typeof direct === "string") {
    return direct;
  }

  for (const nested of [
    (value as { structuredContent?: unknown }).structuredContent,
    (value as { content?: unknown }).content,
    (value as { contents?: unknown }).contents,
    (value as { detailedContent?: unknown }).detailedContent,
    (value as { result?: unknown }).result,
    (value as { text?: unknown }).text,
  ]) {
    if (nested === undefined) {
      continue;
    }

    const extracted = extractDispatchField(nested, field);
    if (extracted) {
      return extracted;
    }
  }

  return undefined;
}

function getProcedureDispatchWaitMs(): number {
  const configured = Number(process.env.MOCK_AGENT_PROCEDURE_DISPATCH_WAIT_MS ?? "0");
  if (Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured);
  }

  if (PROCEDURE_DISPATCH_TIMEOUT_MS > 0) {
    return Math.max(1, Math.min(10, Math.floor(PROCEDURE_DISPATCH_TIMEOUT_MS / 5)));
  }

  return 100;
}

function extractToolResultText(result: unknown): string {
  if (!result || typeof result !== "object") {
    return "tool completed";
  }

  const asyncResult = (result as { result?: unknown }).result;
  if (asyncResult !== undefined) {
    return extractToolResultText(asyncResult);
  }

  const error = (result as { error?: unknown }).error;
  if (typeof error === "string" && error.trim()) {
    return error;
  }

  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  const firstText = content?.find((item) => item.type === "text" && typeof item.text === "string")?.text;
  if (firstText) {
    return firstText;
  }

  const display = (result as { display?: unknown }).display;
  if (typeof display === "string") {
    return display;
  }

  const summary = (result as { summary?: unknown }).summary;
  if (typeof summary === "string") {
    return summary;
  }

  return "tool completed";
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
