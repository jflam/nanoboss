import { NanobossTuiApp, type NanobossTuiAppParams } from "./app.ts";
import type { FrontendConnectionMode } from "../options/frontend-connection.ts";
import { startPrivateHttpServer } from "../http/private-server.ts";

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

export interface RunTuiCliParams extends Omit<NanobossTuiAppParams, "serverUrl"> {
  connectionMode: FrontendConnectionMode;
  serverUrl?: string;
}

interface TuiAppRunner {
  run(): Promise<string | undefined>;
}

type RestoreTerminalInput = () => void | Promise<void>;

export interface RunTuiCliDeps {
  startPrivateHttpServer?: typeof startPrivateHttpServer;
  createApp?: (params: NanobossTuiAppParams) => TuiAppRunner;
  suspendDiscardControlCharacter?: () => RestoreTerminalInput | Promise<RestoreTerminalInput | undefined> | undefined;
}

export async function runTuiCli(params: RunTuiCliParams, deps: RunTuiCliDeps = {}): Promise<void> {
  let server: Awaited<ReturnType<typeof startPrivateHttpServer>> | undefined;
  const restoreTerminalInput = await (deps.suspendDiscardControlCharacter ?? suspendDiscardControlCharacter)();

  try {
    server = params.connectionMode === "private"
      ? await (deps.startPrivateHttpServer ?? startPrivateHttpServer)({ cwd: params.cwd ?? process.cwd() })
      : undefined;
    const serverUrl = server?.baseUrl ?? params.serverUrl;
    if (!serverUrl) {
      throw new Error("nanoboss CLI expected a server URL or private server mode");
    }

    const app = (deps.createApp ?? ((appParams) => new NanobossTuiApp(appParams)))({
      cwd: params.cwd,
      serverUrl,
      showToolCalls: params.showToolCalls,
      sessionId: params.sessionId,
    });
    const sessionId = await app.run();
    if (sessionId) {
      process.stderr.write(`nanoboss session id: ${sessionId}\n`);
    }
  } finally {
    try {
      await restoreTerminalInput?.();
    } finally {
      await server?.stop();
    }
  }
}

async function suspendDiscardControlCharacter(): Promise<RestoreTerminalInput | undefined> {
  if (process.platform === "win32" || !process.stdin.isTTY || !process.stdout.isTTY) {
    return undefined;
  }

  const ttyArgs = getSttyTargetArgs();
  if (!ttyArgs) {
    return undefined;
  }

  const savedState = runStty([...ttyArgs, "-g"]);
  if (!savedState || savedState.exitCode !== 0) {
    return undefined;
  }

  const encodedState = readProcessText(savedState);
  if (!encodedState) {
    return undefined;
  }

  const disabledDiscard = runStty([...ttyArgs, "discard", "undef"]);
  if (!disabledDiscard || disabledDiscard.exitCode !== 0) {
    return undefined;
  }

  return () => {
    void runStty([...ttyArgs, encodedState]);
  };
}

function getSttyTargetArgs(): string[] | undefined {
  if (!Bun.which("stty", { PATH: process.env.PATH })) {
    return undefined;
  }

  return process.platform === "darwin" || process.platform === "freebsd"
    ? ["-f", "/dev/tty"]
    : ["-F", "/dev/tty"];
}

function runStty(args: string[]): Bun.SyncSubprocess | undefined {
  return Bun.spawnSync({
    cmd: ["stty", ...args],
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
}

function readProcessText(result: Bun.SyncSubprocess): string {
  const decoder = new TextDecoder();
  return `${decoder.decode(result.stdout)}${decoder.decode(result.stderr)}`.trim();
}
