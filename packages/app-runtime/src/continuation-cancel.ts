import { defaultCancellationMessage, formatErrorMessage } from "@nanoboss/procedure-sdk";
import { runProcedureCancelHook } from "@nanoboss/procedure-engine";
import { ProcedureRegistry } from "@nanoboss/procedure-catalog";

import { publishRunCancelled } from "./run-publication.ts";
import { persistSessionState, type SessionState } from "./session-runtime.ts";
import type { PendingContinuation } from "@nanoboss/procedure-sdk";

export async function requestContinuationCancel(params: {
  sessionId: string;
  session: SessionState;
  registry: ProcedureRegistry;
  setPendingContinuation: (continuation?: PendingContinuation) => void;
}): Promise<boolean> {
  const pending = params.session.pendingContinuation;
  if (!pending) {
    return false;
  }

  const procedure = params.registry.get(pending.procedure);
  const cancelResult = procedure
    ? await runProcedureCancelHook(procedure, pending.state, {
        sessionId: params.sessionId,
        cwd: params.session.cwd,
      })
    : { ok: true as const };

  if (!cancelResult.ok) {
    const message = formatErrorMessage(cancelResult.error);
    params.session.events.publish(params.sessionId, {
      type: "procedure_panel",
      runId: pending.run.runId,
      procedure: pending.procedure,
      panelId: `panel-${pending.run.runId}-cancel-error`,
      rendererId: "nb/error@1",
      payload: {
        procedure: pending.procedure,
        message: `cancelling /${pending.procedure}: ${message}`,
      },
      severity: "error",
      dismissible: false,
    });
  }

  publishRunCancelled({
    session: params.session,
    sessionId: params.sessionId,
    runId: pending.run.runId,
    procedure: pending.procedure,
    message: defaultCancellationMessage("soft_stop"),
    markRunActivity: () => {},
    run: pending.run,
  });
  params.setPendingContinuation(undefined);
  persistSessionState(params.session);
  return true;
}
