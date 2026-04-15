import { NanobossTuiApp, type NanobossTuiAppParams } from "./app.ts";
import { startPrivateHttpServer } from "@nanoboss/adapters-http";
import type { FrontendConnectionMode } from "./connection-mode.ts";

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
  requestExit?(): void;
  requestSigintExit?(): boolean;
}

type RestoreTerminalInput = () => void | Promise<void>;
type TuiExitSignal = "SIGINT" | "SIGTERM";

export interface RunTuiCliDeps {
  startPrivateHttpServer?: typeof startPrivateHttpServer;
  createApp?: (params: NanobossTuiAppParams) => TuiAppRunner;
  suspendReservedControlCharacters?: () => RestoreTerminalInput | Promise<RestoreTerminalInput | undefined> | undefined;
  addSignalListener?: (signal: TuiExitSignal, listener: () => void) => () => void;
  setExitCode?: (code: number) => void;
  writeStderr?: (text: string) => void;
  now?: () => number;
}

const CTRL_C_EXIT_WINDOW_MS = 500;

export async function runTuiCli(params: RunTuiCliParams, deps: RunTuiCliDeps = {}): Promise<void> {
  let server: Awaited<ReturnType<typeof startPrivateHttpServer>> | undefined;
  let sessionId: string | undefined;
  let app: TuiAppRunner | undefined;
  let exitSignal: TuiExitSignal | undefined;
  let lastSigintAt = Number.NEGATIVE_INFINITY;
  const restoreTerminalInput = await (deps.suspendReservedControlCharacters ?? suspendReservedControlCharacters)();
  const addSignalListener = deps.addSignalListener ?? addProcessSignalListener;
  const removeSignalListeners = [
    addSignalListener("SIGINT", () => {
      const appHandled = app?.requestSigintExit?.();
      if (appHandled) {
        exitSignal ??= "SIGINT";
        return;
      }

      const now = (deps.now ?? Date.now)();
      if (now - lastSigintAt < CTRL_C_EXIT_WINDOW_MS) {
        exitSignal ??= "SIGINT";
        app?.requestExit?.();
        return;
      }

      lastSigintAt = now;
    }),
    addSignalListener("SIGTERM", () => {
      exitSignal ??= "SIGTERM";
      app?.requestExit?.();
    }),
  ];

  try {
    server = params.connectionMode === "private"
      ? await (deps.startPrivateHttpServer ?? startPrivateHttpServer)({ cwd: params.cwd ?? process.cwd() })
      : undefined;
    const serverUrl = server?.baseUrl ?? params.serverUrl;
    if (!serverUrl) {
      throw new Error("nanoboss CLI expected a server URL or private server mode");
    }

    app = (deps.createApp ?? ((appParams) => new NanobossTuiApp(appParams)))({
      cwd: params.cwd,
      serverUrl,
      showToolCalls: params.showToolCalls,
      simplify2AutoApprove: params.simplify2AutoApprove,
      sessionId: params.sessionId,
    });
    if (exitSignal) {
      app.requestExit?.();
    }
    sessionId = await app.run();
  } finally {
    try {
      for (const removeSignalListener of removeSignalListeners.reverse()) {
        removeSignalListener();
      }
    } finally {
      try {
        await restoreTerminalInput?.();
      } finally {
        await server?.stop();
      }
    }
  }

  if (sessionId) {
    (deps.writeStderr ?? process.stderr.write.bind(process.stderr))(`nanoboss session id: ${sessionId}\n`);
  }
  if (exitSignal) {
    (deps.setExitCode ?? setProcessExitCode)(getSignalExitCode(exitSignal));
  }
}

const RESERVED_TTY_CONTROL_CHARACTERS = [
  "discard",
  "dsusp",
] as const;

async function suspendReservedControlCharacters(): Promise<RestoreTerminalInput | undefined> {
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

  let changed = false;
  for (const controlCharacter of RESERVED_TTY_CONTROL_CHARACTERS) {
    const result = runStty([...ttyArgs, controlCharacter, "undef"]);
    if (result && result.exitCode === 0) {
      changed = true;
    }
  }

  if (!changed) {
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

function addProcessSignalListener(signal: TuiExitSignal, listener: () => void): () => void {
  process.on(signal, listener);
  return () => {
    process.off(signal, listener);
  };
}

function setProcessExitCode(code: number): void {
  process.exitCode = code;
}

function getSignalExitCode(signal: TuiExitSignal): number {
  return signal === "SIGINT" ? 130 : 143;
}
