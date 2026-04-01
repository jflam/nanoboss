import * as acp from "@agentclientprotocol/sdk";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

const SUPPORT_LOAD_SESSION = process.env.MOCK_AGENT_SUPPORT_LOAD_SESSION === "1";
const SESSION_STORE_DIR = process.env.MOCK_AGENT_SESSION_STORE_DIR?.trim() || undefined;

class MockAgent implements acp.Agent {
  private readonly sessions = new Map<string, StoredSession>();

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

  async newSession(_params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    const session: StoredSession = {
      sessionId: crypto.randomUUID(),
      turns: [],
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

    const session = readPersistedSession(params.sessionId);
    if (!session) {
      throw new Error(`Unknown session: ${params.sessionId}`);
    }

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

    const text = await answerForPrompt(prompt, session);
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

  private getSession(sessionId: string): StoredSession {
    const existing = this.sessions.get(sessionId) ?? readPersistedSession(sessionId);
    if (!existing) {
      throw new Error(`Unknown session: ${sessionId}`);
    }

    this.sessions.set(sessionId, existing);
    return existing;
  }
}

async function answerForPrompt(prompt: string, session: StoredSession): Promise<string> {
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
