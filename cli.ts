import * as acp from "@agentclientprotocol/sdk";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import readline from "node:readline/promises";
import { Readable, Writable } from "node:stream";

import {
  isCommandsUpdatedEvent,
  isRunFailedEvent,
  isTextDeltaEvent,
  isToolStartedEvent,
  isToolUpdatedEvent,
  type FrontendCommand,
  type FrontendEventEnvelope,
} from "./src/frontend-events.ts";
import {
  createHttpSession,
  sendSessionPrompt,
  startSessionEventStream,
} from "./src/http-client.ts";
import { parseCliOptions } from "./src/cli-options.ts";

class OutputClient {
  availableCommands: string[] = [];
  private readonly toolTitles = new Map<string, string>();
  private outputEndsWithNewline = true;

  constructor(private readonly options: { showToolCalls: boolean }) {}

  async requestPermission(
    params: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    const selected =
      params.options.find((option) => option.kind.startsWith("allow")) ??
      params.options[0];

    if (!selected) {
      return { outcome: { outcome: "cancelled" } };
    }

    return {
      outcome: {
        outcome: "selected",
        optionId: selected.optionId,
      },
    };
  }

  async sessionUpdate(params: acp.SessionNotification): Promise<void> {
    const update = params.update;

    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        if (update.content.type === "text") {
          this.writeOutput(update.content.text);
        }
        break;
      case "tool_call":
        if (this.options.showToolCalls) {
          this.toolTitles.set(update.toolCallId, update.title);
          this.writeToolLine(`[tool] ${update.title}`);
        }
        break;
      case "tool_call_update":
        if (this.options.showToolCalls && update.status) {
          this.handleToolCallUpdate(update);
        }
        break;
      case "available_commands_update":
        this.availableCommands = update.availableCommands.map((command) => `/${command.name}`);
        break;
      default:
        break;
    }
  }

  handleFrontendEvent(event: FrontendEventEnvelope): void {
    if (isCommandsUpdatedEvent(event)) {
      this.availableCommands = event.data.commands.map((command) => `/${command.name}`);
      return;
    }

    if (isTextDeltaEvent(event)) {
      this.writeOutput(event.data.text);
      return;
    }

    if (isToolStartedEvent(event)) {
      if (this.options.showToolCalls) {
        this.toolTitles.set(event.data.toolCallId, event.data.title);
        this.writeToolLine(`[tool] ${event.data.title}`);
      }
      return;
    }

    if (isToolUpdatedEvent(event)) {
      if (!this.options.showToolCalls) {
        return;
      }

      const title = event.data.title ?? this.toolTitles.get(event.data.toolCallId) ?? event.data.toolCallId;
      if (event.data.status === "completed") {
        this.toolTitles.delete(event.data.toolCallId);
        return;
      }
      if (event.data.status === "pending") {
        return;
      }
      if (event.data.status === "failed") {
        this.toolTitles.delete(event.data.toolCallId);
        this.writeToolLine(`[tool] ${title} failed`);
        return;
      }

      this.writeToolLine(`[tool] ${title} ${event.data.status}`);
      return;
    }

    if (isRunFailedEvent(event)) {
      this.writeToolLine(`[run] ${event.data.error}`);
    }
  }

  setCommands(commands: FrontendCommand[]): void {
    this.availableCommands = commands.map((command) => `/${command.name}`);
  }

  completer = (line: string): [string[], string] => {
    const matches = this.availableCommands.filter((command) => command.startsWith(line));
    return [matches.length > 0 ? matches : this.availableCommands, line];
  };

  private writeOutput(text: string): void {
    process.stdout.write(text);
    this.outputEndsWithNewline = text.endsWith("\n");
  }

  writeLineBreak(): void {
    this.writeOutput("\n");
  }

  private writeToolLine(text: string): void {
    const prefix = this.outputEndsWithNewline ? "" : "\n";
    process.stderr.write(`${prefix}${text}\n`);
    this.outputEndsWithNewline = true;
  }

  private handleToolCallUpdate(update: Extract<acp.SessionUpdate, { sessionUpdate: "tool_call_update" }>): void {
    const title = update.title ?? this.toolTitles.get(update.toolCallId) ?? update.toolCallId;

    if (update.status === "completed") {
      this.toolTitles.delete(update.toolCallId);
      return;
    }

    if (update.status === "pending") {
      return;
    }

    if (update.status === "failed") {
      this.toolTitles.delete(update.toolCallId);
      this.writeToolLine(`[tool] ${title} failed`);
      return;
    }

    this.writeToolLine(`[tool] ${title} ${update.status}`);
  }
}

async function main(): Promise<void> {
  const options = parseCliOptions(Bun.argv.slice(2));
  if (options.showHelp) {
    printHelp();
    return;
  }

  if (options.serverUrl) {
    await runHttpCli(options.serverUrl, options.showToolCalls);
    return;
  }

  await runAcpCli(options.showToolCalls);
}

async function runAcpCli(showToolCalls: boolean): Promise<void> {
  const server: ChildProcessByStdio<Writable, Readable, null> = spawn("bun", ["run", "src/server.ts"], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "inherit"],
  });

  const client = new OutputClient({ showToolCalls });
  const stream = acp.ndJsonStream(
    Writable.toWeb(server.stdin),
    Readable.toWeb(server.stdout),
  );
  const connection = new acp.ClientSideConnection(() => client, stream);

  await connection.initialize({
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: {},
  });

  const session = await connection.newSession({
    cwd: process.cwd(),
    mcpServers: [],
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    completer: client.completer,
  });

  try {
    for (;;) {
      const line = await rl.question("> ");
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }
      if (trimmed === "exit" || trimmed === "quit") {
        break;
      }

      await connection.prompt({
        sessionId: session.sessionId,
        prompt: [
          {
            type: "text",
            text: line,
          },
        ],
      });
      client.writeLineBreak();
    }
  } finally {
    rl.close();
    server.kill();
  }
}

async function runHttpCli(serverUrl: string, showToolCalls: boolean): Promise<void> {
  const client = new OutputClient({ showToolCalls });
  const session = await createHttpSession(serverUrl, process.cwd());
  client.setCommands(session.commands);

  const stream = startSessionEventStream({
    baseUrl: serverUrl,
    sessionId: session.sessionId,
    onEvent: (event) => {
      client.handleFrontendEvent(event);
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[stream] ${message}\n`);
    },
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    completer: client.completer,
  });

  try {
    for (;;) {
      const line = await rl.question("> ");
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }
      if (trimmed === "exit" || trimmed === "quit") {
        break;
      }

      await sendSessionPrompt(serverUrl, session.sessionId, line);
      client.writeLineBreak();
    }
  } finally {
    stream.close();
    rl.close();
  }
}

function printHelp(): void {
  process.stdout.write([
    "Usage: bun run cli [--tool-calls|--no-tool-calls] [--server-url <url>]",
    "",
    "Options:",
    "  --tool-calls          Show tool call progress lines (default)",
    "  --no-tool-calls       Hide tool call progress lines",
    "  --server-url <url>    Connect to nano-agentboss over HTTP/SSE",
    "  -h, --help            Show this help text",
    "",
  ].join("\n"));
}

void main();
