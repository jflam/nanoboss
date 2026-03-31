import * as acp from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";

class MockAgent implements acp.Agent {
  constructor(private readonly connection: acp.AgentSideConnection) {}

  async initialize(_params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentInfo: {
        name: "mock-agent",
        version: "0.1.0",
      },
      agentCapabilities: {
        loadSession: false,
      },
    };
  }

  async newSession(_params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    return {
      sessionId: crypto.randomUUID(),
    };
  }

  async authenticate(_params: acp.AuthenticateRequest): Promise<acp.AuthenticateResponse> {
    return {};
  }

  async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
    const prompt = params.prompt
      .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
      .map((block) => block.text)
      .join("\n");

    const text = answerForPrompt(prompt);

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
}

function answerForPrompt(prompt: string): string {
  const normalized = prompt.toLowerCase();

  if (normalized.includes("what is 2+2") || normalized.includes("what is 2 + 2")) {
    return "4";
  }

  if (normalized.includes("first 3 prime numbers")) {
    return "2\n3\n5";
  }

  return `mock:${prompt.trim()}`;
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
