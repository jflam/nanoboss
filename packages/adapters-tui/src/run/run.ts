import type { NanobossTuiAppParams } from "../app/app.ts";
import { startPrivateHttpServer } from "@nanoboss/adapters-http";
import type { FrontendConnectionMode } from "../shared/connection-mode.ts";
import {
  createTuiAppForRun,
  type RunTuiAppDeps,
  type TuiAppRunner,
} from "./run-app.ts";
import { cleanupTuiRun } from "./run-cleanup.ts";
import { reportTuiRunExit } from "./run-exit-report.ts";
export {
  assertInteractiveTty,
  canUseNanobossTui,
} from "./run-tty.ts";
import { installTuiExitSignalHandlers } from "./run-signals.ts";
import {
  addProcessSignalListener,
  setProcessExitCode,
  suspendReservedControlCharacters,
  type RestoreTerminalInput,
  type TuiExitSignal,
} from "./run-terminal.ts";

export interface RunTuiCliParams extends Omit<NanobossTuiAppParams, "serverUrl"> {
  connectionMode: FrontendConnectionMode;
  serverUrl?: string;
}

export interface RunTuiCliDeps extends RunTuiAppDeps {
  startPrivateHttpServer?: typeof startPrivateHttpServer;
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

    app = await createTuiAppForRun({
      cwd: params.cwd,
      serverUrl,
      showToolCalls: params.showToolCalls,
      simplify2AutoApprove: params.simplify2AutoApprove,
      sessionId: params.sessionId,
    }, deps);

    if (exitSignal) {
      app.requestExit?.();
    }
    sessionId = await app.run();
  } finally {
    await cleanupTuiRun({
      removeSignalListeners,
      restoreTerminalInput,
      server,
    });
  }

  reportTuiRunExit({
    sessionId,
    exitSignal,
    writeStderr: deps.writeStderr ?? process.stderr.write.bind(process.stderr),
    setExitCode: deps.setExitCode ?? setProcessExitCode,
  });
}
