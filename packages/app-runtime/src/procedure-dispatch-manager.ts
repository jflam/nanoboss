import { ProcedureDispatchJobManager } from "@nanoboss/procedure-engine";

import type { ActiveRunState } from "./active-run.ts";
import type { SessionState } from "./session-runtime.ts";

export function cancelActiveProcedureDispatches(
  sessionId: string,
  session: SessionState,
  activeRun: ActiveRunState | undefined,
): void {
  if (!activeRun || activeRun.dispatchCorrelationIds.size === 0) {
    return;
  }

  const manager = new ProcedureDispatchJobManager({
    cwd: session.cwd,
    sessionId,
    rootDir: session.store.rootDir,
    getRegistry: async () => {
      throw new Error("Procedure registry is unavailable during cancellation.");
    },
  });

  for (const dispatchCorrelationId of activeRun.dispatchCorrelationIds) {
    manager.cancelByCorrelationId(dispatchCorrelationId);
  }
}
