import { parseFrontendConnectionOptions } from "./src/options/frontend-connection.ts";
import { assertInteractiveTty, runTuiCli } from "@nanoboss/adapters-tui";

export async function runCliCommand(argv: string[] = []): Promise<void> {
  const options = parseFrontendConnectionOptions(argv);
  if (options.showHelp) {
    printHelp();
    return;
  }

  assertInteractiveTty("cli");

  await runTuiCli({
    connectionMode: options.connectionMode,
    serverUrl: options.serverUrl,
    showToolCalls: options.showToolCalls,
    simplify2AutoApprove: options.simplify2AutoApprove,
  });
}

function printHelp(): void {
  process.stdout.write([
    "Usage: nanoboss cli [--tool-calls|--no-tool-calls] [--simplify2-auto-approve] [--server-url <url>]",
    "",
    "Requires an interactive TTY. For automation, use nanoboss http or acp-server.",
    "",
    "Options:",
    "  --tool-calls          Show tool call progress lines (default)",
    "  --no-tool-calls       Hide tool call progress lines",
    "  --simplify2-auto-approve",
    "                        Auto-approve simplify2 checkpoints in the TUI",
    "  --server-url <url>    Connect to an existing nanoboss HTTP/SSE server",
    "                        (default: start a private local server)",
    "  -h, --help            Show this help text",
    "",
  ].join("\n"));
}
