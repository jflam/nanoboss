import { NanobossTuiApp, type NanobossTuiAppParams } from "./app.ts";
import { startPrivateHttpServer } from "@nanoboss/adapters-http";
import type { FrontendConnectionMode } from "./connection-mode.ts";
import { bootExtensions, type BootExtensionsResult, type TuiExtensionBootLog } from "./boot-extensions.ts";
import {
  bootTuiExtensionsForRun,
  flushTuiExtensionStatuses,
} from "./run-extensions.ts";
import { installTuiExitSignalHandlers } from "./run-signals.ts";
import {
  addProcessSignalListener,
  getSignalExitCode,
  setProcessExitCode,
  suspendReservedControlCharacters,
  type RestoreTerminalInput,
  type TuiExitSignal,
} from "./run-terminal.ts";

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
  showStatus?(text: string): void;
}

export interface RunTuiCliDeps {
  startPrivateHttpServer?: typeof startPrivateHttpServer;
  createApp?: (params: NanobossTuiAppParams) => TuiAppRunner;
  /**
   * Override for the TUI-extension boot step. Tests pass a no-op here to
   * avoid touching real disk roots / builtin extensions.
   */
  bootExtensions?: (
    cwd: string,
    options: { log: TuiExtensionBootLog },
  ) => Promise<BootExtensionsResult | undefined> | BootExtensionsResult | undefined;
  suspendReservedControlCharacters?: () => RestoreTerminalInput | Promise<RestoreTerminalInput | undefined> | undefined;
  addSignalListener?: (signal: TuiExitSignal, listener: () => void) => () => void;
  setExitCode?: (code: number) => void;
  writeStderr?: (text: string) => void;
  now?: () => number;
}

export async function runTuiCli(params: RunTuiCliParams, deps: RunTuiCliDeps = {}): Promise<void> {
  let server: Awaited<ReturnType<typeof startPrivateHttpServer>> | undefined;
  let sessionId: string | undefined;
  let app: TuiAppRunner | undefined;
  let exitSignal: TuiExitSignal | undefined;
  const restoreTerminalInput = await (deps.suspendReservedControlCharacters ?? suspendReservedControlCharacters)();
  const addSignalListener = deps.addSignalListener ?? addProcessSignalListener;
  const removeSignalListeners = installTuiExitSignalHandlers({
    addSignalListener,
    getApp: () => app,
    now: deps.now ?? Date.now,
    onExitSignal: (signal) => {
      exitSignal ??= signal;
    },
  });

  try {
    server = params.connectionMode === "private"
      ? await (deps.startPrivateHttpServer ?? startPrivateHttpServer)({ cwd: params.cwd ?? process.cwd() })
      : undefined;
    const serverUrl = server?.baseUrl ?? params.serverUrl;
    if (!serverUrl) {
      throw new Error("nanoboss CLI expected a server URL or private server mode");
    }

    const cwd = params.cwd ?? process.cwd();
    // Boot TUI extensions BEFORE constructing NanobossTuiApp so every
    // registry mutation happens before NanobossAppView is built. Messages
    // emitted by extension activation are buffered here and flushed through
    // the app's status-line pathway once the controller exists.
    const extensionBoot = await bootTuiExtensionsForRun(cwd, deps.bootExtensions ?? bootExtensions);

    app = (deps.createApp ?? ((appParams) => new NanobossTuiApp(appParams)))({
      cwd: params.cwd,
      serverUrl,
      showToolCalls: params.showToolCalls,
      simplify2AutoApprove: params.simplify2AutoApprove,
      sessionId: params.sessionId,
      listExtensionEntries: extensionBoot.bootResult
        ? () => extensionBoot.bootResult!.registry.listMetadata()
        : undefined,
    });

    flushTuiExtensionStatuses(app, extensionBoot);

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
