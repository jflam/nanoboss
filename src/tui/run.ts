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
