import {
  isProcedureDispatchCancellationRequested,
} from "./files.ts";
import type { ProcedureDispatchJobStore } from "./job-store.ts";
import { markJobCancelled } from "./status.ts";
import { PROCEDURE_DISPATCH_WAIT_POLL_MS } from "./wait.ts";

export function watchProcedureDispatchCancellation(params: {
  rootDir: string;
  dispatchId: string;
  dispatchCorrelationId: string;
  jobStore: ProcedureDispatchJobStore;
  controller: AbortController;
}): () => void {
  const poll = () => {
    if (params.controller.signal.aborted) {
      return;
    }

    const latest = params.jobStore.read(params.dispatchId);
    if (
      latest.status !== "cancelled"
      && !isProcedureDispatchCancellationRequested(params.rootDir, params.dispatchCorrelationId)
    ) {
      return;
    }

    if (latest.status !== "cancelled") {
      params.jobStore.write(markJobCancelled(latest));
    }
    params.controller.abort();
  };

  poll();
  const timer = setInterval(poll, PROCEDURE_DISPATCH_WAIT_POLL_MS);
  return () => {
    clearInterval(timer);
  };
}
