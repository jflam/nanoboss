import { appendTimingTraceEvent, createRunTimingTrace } from "@nanoboss/app-support";
import type {
  DownstreamAgentSelection,
  RunRef,
} from "@nanoboss/contracts";
import type {
  ProcedureRegistryLike,
  RunResult,
} from "@nanoboss/procedure-sdk";
import { defaultCancellationMessage } from "@nanoboss/procedure-sdk";
import { SessionStore } from "@nanoboss/store";

import {
  ProcedureCancelledError,
  ProcedureExecutionError,
  executeProcedure,
} from "../procedure-runner.ts";
import { runResultFromRunRecord } from "../run-result.ts";
import { watchProcedureDispatchCancellation } from "./cancellation-watcher.ts";
import {
  clearProcedureDispatchCancellation,
  isProcedureDispatchCancellationRequested,
  requestProcedureDispatchCancellation,
} from "./files.ts";
import { ProcedureDispatchJobStore } from "./job-store.ts";
import {
  ProcedureDispatchProgressEmitter,
  buildProcedureDispatchProgressPath,
} from "./progress.ts";
import { findRecoveredProcedureDispatchRun } from "./recovery.ts";
import { createProcedureDispatchRuntimeBindings } from "./runtime-bindings.ts";
import {
  isDeadWorkerJob,
  isTerminalStatus,
  looksLikeProcedureFailureRecord,
  markJobCancelled,
  toProcedureDispatchStatusResult,
} from "./status.ts";
import {
  PROCEDURE_DISPATCH_WAIT_POLL_MS,
  clampProcedureDispatchWaitMs,
} from "./wait.ts";
import { spawnProcedureDispatchWorker } from "./worker-process.ts";

export {
  buildProcedureDispatchCancelPath,
  buildProcedureDispatchCancelsDir,
  buildProcedureDispatchJobPath,
  buildProcedureDispatchJobsDir,
  clearProcedureDispatchCancellation,
  isProcedureDispatchCancellationRequested,
  requestProcedureDispatchCancellation,
} from "./files.ts";

export type ProcedureDispatchJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface ProcedureDispatchJob {
  dispatchId: string;
  sessionId: string;
  procedure: string;
  prompt: string;
  status: ProcedureDispatchJobStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  dispatchCorrelationId: string;
  defaultAgentSelection?: DownstreamAgentSelection;
  run?: RunRef;
  result?: RunResult;
  error?: string;
  workerPid?: number;
}

export interface ProcedureDispatchStartResult {
  dispatchId: string;
  status: Extract<ProcedureDispatchJobStatus, "queued" | "running" | "completed">;
}

export interface ProcedureDispatchStatusResult {
  dispatchId: string;
  status: ProcedureDispatchJobStatus;
  procedure: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  run?: RunRef;
  result?: RunResult;
  error?: string;
}

interface ProcedureDispatchJobManagerParams {
  cwd: string;
  sessionId: string;
  rootDir: string;
  getRegistry: () => Promise<ProcedureRegistryLike>;
}

export class ProcedureDispatchJobManager {
  private readonly jobStore: ProcedureDispatchJobStore;

  constructor(private readonly params: ProcedureDispatchJobManagerParams) {
    this.jobStore = new ProcedureDispatchJobStore(params.rootDir);
  }

  async start(args: {
    name: string;
    prompt: string;
    defaultAgentSelection?: DownstreamAgentSelection;
    dispatchCorrelationId?: string;
  }): Promise<ProcedureDispatchStartResult> {
    if (args.name === "default") {
      throw new Error("procedure dispatch cannot run default; continue the master conversation directly instead.");
    }

    const registry = await this.params.getRegistry();
    const procedure = registry.get(args.name);
    if (!procedure) {
      throw new Error(`Unknown procedure: ${args.name}`);
    }

    const existing = args.dispatchCorrelationId
      ? this.jobStore.findReusableByCorrelationId(args.dispatchCorrelationId, args.name, args.prompt)
      : undefined;
    if (existing) {
      return {
        dispatchId: existing.dispatchId,
        status: existing.status === "queued" || existing.status === "running" || existing.status === "completed"
          ? existing.status
          : "completed",
      };
    }

    const createdAt = new Date().toISOString();
    const dispatchId = `dispatch_${crypto.randomUUID()}`;
    const job: ProcedureDispatchJob = {
      dispatchId,
      sessionId: this.params.sessionId,
      procedure: args.name,
      prompt: args.prompt,
      status: "queued",
      createdAt,
      updatedAt: createdAt,
      dispatchCorrelationId: args.dispatchCorrelationId ?? dispatchId,
      defaultAgentSelection: args.defaultAgentSelection,
    };

    const cancellationRequested = isProcedureDispatchCancellationRequested(
      this.params.rootDir,
      job.dispatchCorrelationId,
    );
    appendTimingTraceEvent(
      createRunTimingTrace(this.params.rootDir, job.dispatchCorrelationId),
      "dispatch_job",
      "start_requested",
      {
        procedure: args.name,
        cancelledBeforeStart: cancellationRequested,
      },
    );
    this.jobStore.write(cancellationRequested ? markJobCancelled(job) : job);
    if (!cancellationRequested) {
      const workerPid = this.spawnWorker(dispatchId);
      this.jobStore.writeWorkerPid(dispatchId, workerPid);
      appendTimingTraceEvent(
        createRunTimingTrace(this.params.rootDir, job.dispatchCorrelationId),
        "dispatch_job",
        "worker_spawned",
        {
          dispatchId,
          workerPid,
        },
      );
    }

    return {
      dispatchId,
      status: "queued",
    };
  }

  async status(dispatchId: string): Promise<ProcedureDispatchStatusResult> {
    const job = await this.reconcileJob(this.jobStore.read(dispatchId));
    return toProcedureDispatchStatusResult(job);
  }

  async wait(dispatchId: string, waitMs?: number): Promise<ProcedureDispatchStatusResult> {
    const boundedWaitMs = clampProcedureDispatchWaitMs(waitMs);
    const deadline = Date.now() + boundedWaitMs;

    for (;;) {
      const current = await this.status(dispatchId);
      if (isTerminalStatus(current.status) || Date.now() >= deadline) {
        return current;
      }

      await Bun.sleep(PROCEDURE_DISPATCH_WAIT_POLL_MS);
    }
  }

  cancelByCorrelationId(dispatchCorrelationId: string): void {
    requestProcedureDispatchCancellation(this.params.rootDir, dispatchCorrelationId);
    for (const job of this.jobStore.list()) {
      if (job.dispatchCorrelationId !== dispatchCorrelationId || isTerminalStatus(job.status)) {
        continue;
      }

      this.jobStore.write(markJobCancelled(job));
    }
  }

  cancelMatchingProcedures(procedures: readonly string[]): number {
    const names = new Set(procedures);
    let cancelled = 0;
    for (const job of this.jobStore.list()) {
      if (!names.has(job.procedure) || isTerminalStatus(job.status)) {
        continue;
      }

      requestProcedureDispatchCancellation(this.params.rootDir, job.dispatchCorrelationId);
      this.jobStore.write(markJobCancelled(job));
      cancelled += 1;
    }

    return cancelled;
  }

  async run(dispatchId: string): Promise<void> {
    let job = this.jobStore.read(dispatchId);
    const timingTrace = createRunTimingTrace(this.params.rootDir, job.dispatchCorrelationId);
    appendTimingTraceEvent(timingTrace, "dispatch_worker", "run_started", {
      dispatchId,
      procedure: job.procedure,
    });
    if (job.status === "cancelled" || isProcedureDispatchCancellationRequested(this.params.rootDir, job.dispatchCorrelationId)) {
      if (job.status !== "cancelled") {
        this.jobStore.write(markJobCancelled(job));
      }
      appendTimingTraceEvent(timingTrace, "dispatch_worker", "run_aborted_before_start");
      return;
    }

    if (isTerminalStatus(job.status)) {
      appendTimingTraceEvent(timingTrace, "dispatch_worker", "run_skipped_terminal_status", {
        status: job.status,
      });
      return;
    }

    const softStopController = new AbortController();
    const stopWatchingCancellation = watchProcedureDispatchCancellation({
      rootDir: this.params.rootDir,
      dispatchId,
      dispatchCorrelationId: job.dispatchCorrelationId,
      jobStore: this.jobStore,
      controller: softStopController,
    });
    const startedAt = new Date().toISOString();
    job = {
      ...job,
      status: "running",
      startedAt: job.startedAt ?? startedAt,
      updatedAt: startedAt,
    };
    this.jobStore.write(job);

    const store = this.createStore();
    const bindings = createProcedureDispatchRuntimeBindings(this.params.cwd, job.defaultAgentSelection);
    const emitter = new ProcedureDispatchProgressEmitter(
      buildProcedureDispatchProgressPath(store.rootDir, job.dispatchCorrelationId),
      () => {
        this.touchRunningJob(dispatchId);
      },
    );

    try {
      const registry = await this.params.getRegistry();
      appendTimingTraceEvent(timingTrace, "dispatch_worker", "registry_loaded");
      const procedure = registry.get(job.procedure);
      if (!procedure) {
        throw new Error(`Unknown procedure: ${job.procedure}`);
      }

      appendTimingTraceEvent(timingTrace, "dispatch_worker", "procedure_execution_started", {
        procedure: job.procedure,
      });
      const result = await executeProcedure({
        cwd: this.params.cwd,
        sessionId: this.params.sessionId,
        store,
        registry,
        procedure,
        prompt: job.prompt,
        emitter,
        softStopSignal: softStopController.signal,
        bindings,
        dispatchCorrelationId: job.dispatchCorrelationId,
        timingTrace,
      });

      const completedAt = new Date().toISOString();
      const latest = this.jobStore.read(dispatchId);
      if (latest.status === "cancelled" || softStopController.signal.aborted) {
        this.jobStore.write({
          ...markJobCancelled(latest, completedAt),
          run: result.run,
          result,
          error: defaultCancellationMessage("soft_stop"),
          defaultAgentSelection: result.defaultAgentSelection ?? job.defaultAgentSelection,
        });
        return;
      }

      this.jobStore.write({
        ...latest,
        status: "completed",
        updatedAt: completedAt,
        completedAt,
        run: result.run,
        result,
        error: undefined,
        defaultAgentSelection: result.defaultAgentSelection ?? job.defaultAgentSelection,
      });
      appendTimingTraceEvent(timingTrace, "dispatch_worker", "procedure_execution_completed", {
        procedure: job.procedure,
        runId: result.run.runId,
      });
    } catch (error) {
      const completedAt = new Date().toISOString();
      const latest = this.jobStore.read(dispatchId);
      const message = error instanceof Error ? error.message : String(error);
      const run = error instanceof ProcedureExecutionError || error instanceof ProcedureCancelledError
        ? error.run
        : latest.run;
      if (latest.status === "cancelled" || softStopController.signal.aborted) {
        this.jobStore.write({
          ...markJobCancelled(latest, completedAt),
          run,
          error: message,
        });
        return;
      }

      this.jobStore.write({
        ...latest,
        status: "failed",
        updatedAt: completedAt,
        completedAt,
        run,
        error: message,
      });
      appendTimingTraceEvent(timingTrace, "dispatch_worker", "procedure_execution_failed", {
        procedure: job.procedure,
        error: message,
      });
      throw error;
    } finally {
      stopWatchingCancellation();
    }
  }

  private createStore(): SessionStore {
    return new SessionStore({
      sessionId: this.params.sessionId,
      cwd: this.params.cwd,
      rootDir: this.params.rootDir,
    });
  }

  private spawnWorker(dispatchId: string): number | undefined {
    return spawnProcedureDispatchWorker({
      cwd: this.params.cwd,
      sessionId: this.params.sessionId,
      rootDir: this.params.rootDir,
      dispatchId,
    });
  }

  private touchRunningJob(dispatchId: string): void {
    const job = this.jobStore.read(dispatchId);
    if (isTerminalStatus(job.status)) {
      return;
    }

    this.jobStore.write({
      ...job,
      updatedAt: new Date().toISOString(),
    });
  }

  private async reconcileJob(job: ProcedureDispatchJob): Promise<ProcedureDispatchJob> {
    if (job.status === "completed" && job.result) {
      return job;
    }

    const record = job.run
      ? this.tryReadStoredRunRecord(job.run)
      : findRecoveredProcedureDispatchRun(this.createStore(), {
        procedureName: job.procedure,
        dispatchCorrelationId: job.dispatchCorrelationId,
      });

    if (!record) {
      if (!isTerminalStatus(job.status) && isDeadWorkerJob(job)) {
        const failed: ProcedureDispatchJob = {
          ...job,
          status: "failed",
          updatedAt: new Date().toISOString(),
          completedAt: job.completedAt ?? new Date().toISOString(),
          error: job.error ?? `Procedure dispatch worker exited before completing: pid ${job.workerPid}`,
        };
        this.jobStore.write(failed);
        return failed;
      }

      return job;
    }

    if (job.status === "failed" || job.status === "cancelled") {
      return job;
    }

    if (job.status !== "completed" && looksLikeProcedureFailureRecord(record)) {
      const completedAt = job.completedAt ?? new Date().toISOString();
      const failed: ProcedureDispatchJob = {
        ...job,
        status: "failed",
        updatedAt: new Date().toISOString(),
        completedAt,
        run: record.run,
        error: job.error ?? record.output.summary ?? `${job.procedure} failed`,
      };
      this.jobStore.write(failed);
      return failed;
    }

    const result = runResultFromRunRecord(record, {
      tokenUsage: job.result?.tokenUsage,
      defaultAgentSelection: job.result?.defaultAgentSelection ?? job.defaultAgentSelection,
    });
    const completedAt = job.completedAt ?? new Date().toISOString();
    const reconciled: ProcedureDispatchJob = {
      ...job,
      status: "completed",
      updatedAt: new Date().toISOString(),
      completedAt,
      run: result.run,
      result,
      error: undefined,
      defaultAgentSelection: result.defaultAgentSelection ?? job.defaultAgentSelection,
    };
    this.jobStore.write(reconciled);
    return reconciled;
  }

  private tryReadStoredRunRecord(run: RunRef) {
    try {
      return this.createStore().getRun(run);
    } catch {
      return undefined;
    }
  }

}
