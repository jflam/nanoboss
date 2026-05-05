import type { RestoreTerminalInput } from "./run-terminal.ts";

interface TuiPrivateServer {
  stop(): void | Promise<void>;
}

interface TuiRunCleanupResources {
  removeSignalListeners: Array<() => void>;
  restoreTerminalInput?: RestoreTerminalInput;
  server?: TuiPrivateServer;
}

export async function cleanupTuiRun(resources: TuiRunCleanupResources): Promise<void> {
  try {
    for (const removeSignalListener of resources.removeSignalListeners.reverse()) {
      removeSignalListener();
    }
  } finally {
    try {
      await resources.restoreTerminalInput?.();
    } finally {
      await resources.server?.stop();
    }
  }
}
