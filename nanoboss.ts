import { DEFAULT_HTTP_SERVER_PORT, DEFAULT_HTTP_SERVER_URL } from "./src/core/defaults.ts";

export type NanobossSubcommand = "cli" | "resume" | "http" | "acp-server" | "procedure-dispatch-worker" | "doctor" | "mcp" | "help";

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
      await import("./cli.ts").then(({ runCliCommand }) => runCliCommand(parsed.args));
      return;
    case "resume":
      await import("./resume.ts").then(({ runResumeCommand }) => runResumeCommand(parsed.args));
      return;
    case "http":
      await import("@nanoboss/adapters-http").then(({ runHttpServerCommand }) => runHttpServerCommand(parsed.args));
      return;
    case "acp-server":
      await import("@nanoboss/adapters-acp-server").then(({ runAcpServerCommand }) => runAcpServerCommand());
      return;
    case "mcp":
      await runMcpSubcommand(parsed.args);
      return;
    case "procedure-dispatch-worker":
      await import("@nanoboss/procedure-engine").then(({ runProcedureDispatchWorkerCommand }) => runProcedureDispatchWorkerCommand(parsed.args));
      return;
    case "doctor":
      await import("./src/core/doctor.ts").then(({ runDoctorCommand }) => runDoctorCommand(parsed.args));
      return;
    case "help":
      printHelp();
      return;
  }
}

async function runMcpSubcommand(argv: string[]): Promise<void> {
  const [subcommand] = argv;

  if (!subcommand) {
    const {
      MCP_INSTRUCTIONS,
      MCP_SERVER_NAME,
      runMcpServer,
    } = await import("@nanoboss/adapters-mcp");
    const { createCurrentSessionBackedNanobossRuntimeService } = await import("./src/runtime/service.ts");
    const runtime = createCurrentSessionBackedNanobossRuntimeService();
    await runMcpServer(runtime, {
      serverName: MCP_SERVER_NAME,
      instructions: MCP_INSTRUCTIONS,
    });
    return;
  }

  if (subcommand === "help" || subcommand === "-h" || subcommand === "--help") {
    printMcpHelp();
    return;
  }

  throw new Error(`Unknown mcp command: ${subcommand}`);
}

function printMcpHelp(): void {
  process.stdout.write([
    "Usage: nanoboss mcp",
    "",
    "Launch the global nanoboss MCP stdio server.",
    "",
  ].join("\n"));
}

export function printHelp(): void {
  process.stdout.write([
    "Usage: nanoboss <command> [options]",
    "",
    "Commands:",
    "  cli                Launch the interactive frontend",
    "  resume             Resume a saved CLI session",
    "  http               Launch the HTTP/SSE server",
    "  doctor             Show agent/ACP health and optionally register nanoboss MCP",
    "  mcp                Launch the global nanoboss MCP stdio server",
    "  acp-server         Launch the internal stdio ACP server",
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
