import { runCliCommand } from "./cli.ts";
import { DEFAULT_HTTP_SERVER_PORT, DEFAULT_HTTP_SERVER_URL } from "./src/defaults.ts";
import { runDoctorCommand } from "./src/doctor.ts";
import { runHttpServerCommand } from "./src/http-server.ts";
import { runMcpCommand } from "./src/mcp-proxy.ts";
import { runSessionMcpStdioCommand } from "./src/session-mcp-stdio.ts";
import { runAcpServerCommand } from "./src/server.ts";

export type NanobossSubcommand = "cli" | "server" | "acp-server" | "session-mcp" | "doctor" | "mcp" | "help";

export interface NanobossArgs {
  command: NanobossSubcommand;
  args: string[];
}

export function parseNanobossArgs(argv: string[]): NanobossArgs {
  const [first, ...rest] = argv;

  if (!first || first === "help" || first === "-h" || first === "--help") {
    return {
      command: "help",
      args: [],
    };
  }

  if (
    first === "cli" ||
    first === "server" ||
    first === "acp-server" ||
    first === "doctor" ||
    first === "mcp" ||
    first === "session-mcp"
  ) {
    return {
      command: first,
      args: rest,
    };
  }

  throw new Error(`Unknown nanoboss command: ${first}`);
}

export async function runNanoboss(argv: string[]): Promise<void> {
  const parsed = parseNanobossArgs(argv);

  switch (parsed.command) {
    case "cli":
      await runCliCommand(parsed.args);
      return;
    case "server":
      await runHttpServerCommand(parsed.args);
      return;
    case "acp-server":
      await runAcpServerCommand();
      return;
    case "session-mcp":
      await runSessionMcpStdioCommand(parsed.args);
      return;
    case "doctor":
      await runDoctorCommand(parsed.args);
      return;
    case "mcp":
      await runMcpCommand(parsed.args);
      return;
    case "help":
      printHelp();
      return;
  }
}

export function printHelp(): void {
  process.stdout.write([
    "Usage: nanoboss <command> [options]",
    "",
    "Commands:",
    "  cli                Launch the CLI frontend",
    "  server             Launch the HTTP/SSE server",
    "  doctor             Show MCP/agent health and optionally register nanoboss MCP",
    "  mcp                Launch the static nanoboss MCP stdio server",
    "  acp-server         Launch the internal stdio ACP server",
    "  session-mcp        Launch the internal stdio MCP server for session refs",
    "  help               Show this help text",
    "",
    "Examples:",
    `  nanoboss server --port ${DEFAULT_HTTP_SERVER_PORT}`,
    "  nanoboss cli",
    "  nanoboss doctor --register",
    `  nanoboss cli --server-url ${DEFAULT_HTTP_SERVER_URL}`,
    "",
  ].join("\n"));
}

if (import.meta.main) {
  await runNanoboss(Bun.argv.slice(2));
}
