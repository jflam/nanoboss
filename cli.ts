import { parseCliOptions } from "./src/options/cli.ts";
import { assertInteractiveTty, runTuiCli } from "./src/tui/run.ts";

export async function runCliCommand(argv: string[] = []): Promise<void> {
  const options = parseCliOptions(argv);
  if (options.showHelp) {
    printHelp();
    return;
  }

  assertInteractiveTty("cli");

  await runTuiCli({
    connectionMode: options.connectionMode,
    serverUrl: options.serverUrl,
    showToolCalls: options.showToolCalls,
  });
}

function printHelp(): void {
  process.stdout.write([
    "Usage: nanoboss cli [--tool-calls|--no-tool-calls] [--server-url <url>]",
    "",
    "Requires an interactive TTY. For automation, use nanoboss http or acp-server.",
    "",
    "Options:",
    "  --tool-calls          Show tool call progress lines (default)",
    "  --no-tool-calls       Hide tool call progress lines",
    "  --server-url <url>    Connect to an existing nanoboss HTTP/SSE server",
    "                        (default: start a private local server)",
    "  -h, --help            Show this help text",
    "",
  ].join("\n"));
}
