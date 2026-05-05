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
