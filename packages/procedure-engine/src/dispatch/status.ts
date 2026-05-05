import type { RunRecord } from "@nanoboss/contracts";
import { defaultCancellationMessage } from "@nanoboss/procedure-sdk";

import type {
  ProcedureDispatchJob,
  ProcedureDispatchJobStatus,
  ProcedureDispatchStatusResult,
} from "./jobs.ts";

export function isTerminalStatus(status: ProcedureDispatchJobStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export function isDeadWorkerJob(job: ProcedureDispatchJob): boolean {
  return (
    (job.status === "queued" || job.status === "running") &&
    typeof job.workerPid === "number" &&
    job.workerPid > 0 &&
    !isProcessAlive(job.workerPid)
  );
}

export function looksLikeProcedureFailureRecord(record: RunRecord): boolean {
  return (
    record.output.data === undefined &&
    record.output.display === undefined &&
    record.output.memory === undefined &&
    typeof record.output.summary === "string" &&
    /^Error:/i.test(record.output.summary)
  );
}

export function toProcedureDispatchStatusResult(job: ProcedureDispatchJob): ProcedureDispatchStatusResult {
  return {
    dispatchId: job.dispatchId,
    status: job.status,
    procedure: job.procedure,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    run: job.run,
    result: job.result,
    error: job.error,
  };
}

export function markJobCancelled(
  job: ProcedureDispatchJob,
  timestamp = new Date().toISOString(),
): ProcedureDispatchJob {
  return {
    ...job,
    status: "cancelled",
    updatedAt: timestamp,
    completedAt: job.completedAt ?? timestamp,
    error: job.error ?? defaultCancellationMessage("soft_stop"),
  };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      return true;
    }
    return false;
  }
}
