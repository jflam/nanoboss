import { runCliCommand } from "./cli.ts";
import { runResumeCommand } from "./resume.ts";
import { DEFAULT_HTTP_SERVER_PORT, DEFAULT_HTTP_SERVER_URL } from "./src/defaults.ts";
import { runDoctorCommand } from "./src/doctor.ts";
import { runHttpServerCommand } from "./src/http-server.ts";
import { runMcpCommand } from "./src/mcp-proxy.ts";
import { runSessionMcpStdioCommand } from "./src/session-mcp-stdio.ts";
import { runProcedureDispatchWorkerCommand } from "./src/procedure-dispatch-jobs.ts";
import { runAcpServerCommand } from "./src/server.ts";

export type NanobossSubcommand = "cli" | "resume" | "http" | "acp-server" | "session-mcp" | "procedure-dispatch-worker" | "doctor" | "mcp" | "help";

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
    first === "resume" ||
    first === "http" ||
    first === "acp-server" ||
    first === "doctor" ||
    first === "mcp" ||
    first === "session-mcp" ||
    first === "procedure-dispatch-worker"
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
    case "resume":
      await runResumeCommand(parsed.args);
      return;
    case "http":
      await runHttpServerCommand(parsed.args);
      return;
    case "acp-server":
      await runAcpServerCommand();
      return;
    case "session-mcp":
      await runSessionMcpStdioCommand(parsed.args);
      return;
    case "procedure-dispatch-worker":
      await runProcedureDispatchWorkerCommand(parsed.args);
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
    "  cli                Launch the interactive frontend",
    "  resume             Resume a saved CLI session",
    "  http               Launch the HTTP/SSE server",
    "  doctor             Show agent/session-MCP health and optionally register nanoboss MCP",
    "  mcp                Launch the global nanoboss MCP stdio server",
    "  acp-server         Launch the internal stdio ACP server",
    "  session-mcp        Launch the internal stdio session MCP server",
    "  procedure-dispatch-worker  Launch the internal async procedure dispatch worker",
    "  help               Show this help text",
    "",
    "Examples:",
    `  nanoboss http --port ${DEFAULT_HTTP_SERVER_PORT}`,
    "  nanoboss cli",
    "  nanoboss resume",
    "  nanoboss doctor --register",
    `  nanoboss cli --server-url ${DEFAULT_HTTP_SERVER_URL}`,
    "",
  ].join("\n"));
}

if (import.meta.main) {
  await runNanoboss(Bun.argv.slice(2));
}
