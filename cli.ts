import * as acp from "@agentclientprotocol/sdk";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import readline from "node:readline/promises";
import { Readable, Writable } from "node:stream";

class CliClient implements acp.Client {
  availableCommands: string[] = [];
  private readonly toolTitles = new Map<string, string>();
  private outputEndsWithNewline = true;

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
        this.toolTitles.set(update.toolCallId, update.title);
        this.writeToolLine(`[tool] ${update.title}`);
        break;
      case "tool_call_update":
        if (update.status) {
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
  const server: ChildProcessByStdio<Writable, Readable, null> = spawn("bun", ["run", "src/server.ts"], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "inherit"],
  });

  const client = new CliClient();
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

void main();
