import { runCliCommand } from "./cli.ts";
import { DEFAULT_HTTP_SERVER_PORT, DEFAULT_HTTP_SERVER_URL } from "./src/defaults.ts";
import { runHttpServerCommand } from "./src/http-server.ts";
import { runAcpServerCommand } from "./src/server.ts";

export type NanobossSubcommand = "cli" | "server" | "acp-server" | "help";

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
    first === "acp-server"
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
    "  acp-server         Launch the internal stdio ACP server",
    "  help               Show this help text",
    "",
    "Examples:",
    `  nanoboss server --port ${DEFAULT_HTTP_SERVER_PORT}`,
    "  nanoboss cli",
    `  nanoboss cli --server-url ${DEFAULT_HTTP_SERVER_URL}`,
    "",
  ].join("\n"));
}

if (import.meta.main) {
  await runNanoboss(Bun.argv.slice(2));
}
