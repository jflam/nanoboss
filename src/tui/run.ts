import { DEFAULT_HTTP_SERVER_URL } from "../defaults.ts";
import { parseCliOptions } from "../cli-options.ts";

import { NanobossTuiApp, type NanobossTuiAppParams } from "./app.ts";

export function canUseNanobossTui(): boolean {
  return process.stdin.isTTY && process.stdout.isTTY;
}

export function assertInteractiveTty(commandName: string): void {
  if (canUseNanobossTui()) {
    return;
  }

  throw new Error(
    `nanoboss ${commandName} requires an interactive TTY; use the HTTP server, MCP, or ACP interfaces for automation.`,
  );
}

export async function runTuiCli(params: NanobossTuiAppParams): Promise<void> {
  const app = new NanobossTuiApp(params);
  const sessionId = await app.run();
  if (sessionId) {
    process.stderr.write(`nanoboss session id: ${sessionId}\n`);
  }
}

export async function runTuiCommand(argv: string[] = []): Promise<void> {
  const options = parseCliOptions(argv);
  if (options.showHelp) {
    printHelp();
    return;
  }

  assertInteractiveTty("tui");

  await runTuiCli({
    serverUrl: options.serverUrl,
    showToolCalls: options.showToolCalls,
  });
}

function printHelp(): void {
  process.stdout.write([
    "Usage: nanoboss tui [--tool-calls|--no-tool-calls] [--server-url <url>]",
    "",
    "Options:",
    "  --tool-calls          Show tool call progress lines (default)",
    "  --no-tool-calls       Hide tool call progress lines",
    `  --server-url <url>    Connect to nanoboss over HTTP/SSE (default: ${DEFAULT_HTTP_SERVER_URL})`,
    "  -h, --help            Show this help text",
    "",
  ].join("\n"));
}
