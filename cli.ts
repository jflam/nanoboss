import { parseCliOptions } from "./src/cli-options.ts";
import { DEFAULT_HTTP_SERVER_URL } from "./src/defaults.ts";
import { runLegacyHttpCli } from "./src/http-cli-legacy.ts";
import { canUseNanobossTui, runTuiCli } from "./src/tui/run.ts";

export async function runCliCommand(argv: string[] = []): Promise<void> {
  const options = parseCliOptions(argv);
  if (options.showHelp) {
    printHelp();
    return;
  }

  if (canUseNanobossTui()) {
    await runTuiCli({
      serverUrl: options.serverUrl,
      showToolCalls: options.showToolCalls,
    });
    return;
  }

  await runLegacyHttpCli({
    serverUrl: options.serverUrl,
    showToolCalls: options.showToolCalls,
  });
}

function printHelp(): void {
  process.stdout.write([
    "Usage: nanoboss cli [--tool-calls|--no-tool-calls] [--server-url <url>]",
    "",
    "Interactive TTY sessions use the pi-tui frontend. Non-TTY sessions use the legacy line-based fallback.",
    "",
    "Options:",
    "  --tool-calls          Show tool call progress lines (default)",
    "  --no-tool-calls       Hide tool call progress lines",
    `  --server-url <url>    Connect to nanoboss over HTTP/SSE (default: ${DEFAULT_HTTP_SERVER_URL})`,
    "  -h, --help            Show this help text",
    "",
  ].join("\n"));
}

if (import.meta.main) {
  await runCliCommand(Bun.argv.slice(2));
}
