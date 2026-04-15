import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { defaultCancellationMessage } from "../core/cancellation.ts";
import { resolveDownstreamAgentConfig } from "../core/config.ts";
import { appendTimingTraceEvent, createRunTimingTrace } from "../core/timing-trace.ts";
import { findRecoveredProcedureDispatchRun } from "./dispatch-recovery.ts";
import {
  ProcedureDispatchProgressEmitter,
  buildProcedureDispatchProgressPath,
} from "./dispatch-progress.ts";
import {
  TopLevelProcedureCancelledError,
  TopLevelProcedureExecutionError,
  executeTopLevelProcedure,
} from "./runner.ts";
import { runResultFromRunRecord } from "../core/run-result.ts";
import { ProcedureRegistry } from "./registry.ts";
import { SessionStore } from "@nanoboss/store";
import { resolveSelfCommand } from "../core/self-command.ts";
import type {
  DownstreamAgentSelection,
  ProcedureRegistryLike,
  RunRecord,
  RunRef,
  RunResult,
} from "@nanoboss/contracts";
import { requireValue } from "../util/argv.ts";

const PROCEDURE_DISPATCH_JOBS_DIR = "procedure-dispatch-jobs";
const PROCEDURE_DISPATCH_CANCELS_DIR = "procedure-dispatch-cancels";
const DEFAULT_WAIT_MS = 1_000;
const MAX_WAIT_MS = 2_000;
const WAIT_POLL_MS = 100;

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
  private readonly jobsDir: string;

  constructor(private readonly params: ProcedureDispatchJobManagerParams) {
    this.jobsDir = buildProcedureDispatchJobsDir(params.rootDir);
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
      ? this.findReusableJobByCorrelationId(args.dispatchCorrelationId, args.name, args.prompt)
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
    this.writeJob(cancellationRequested ? markJobCancelled(job) : job);
    if (!cancellationRequested) {
      const workerPid = this.spawnWorker(dispatchId);
      this.writeJobWorkerPid(dispatchId, workerPid);
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
    const job = await this.reconcileJob(this.readJob(dispatchId));
    return toProcedureDispatchStatusResult(job);
  }

  async wait(dispatchId: string, waitMs?: number): Promise<ProcedureDispatchStatusResult> {
    const boundedWaitMs = clampWaitMs(waitMs);
    const deadline = Date.now() + boundedWaitMs;

    for (;;) {
      const current = await this.status(dispatchId);
      if (isTerminalStatus(current.status) || Date.now() >= deadline) {
        return current;
      }

      await Bun.sleep(WAIT_POLL_MS);
    }
  }

  cancelByCorrelationId(dispatchCorrelationId: string): void {
    requestProcedureDispatchCancellation(this.params.rootDir, dispatchCorrelationId);
    for (const job of this.listJobs()) {
      if (job.dispatchCorrelationId !== dispatchCorrelationId || isTerminalStatus(job.status)) {
        continue;
      }

      this.writeJob(markJobCancelled(job));
    }
  }

  cancelMatchingProcedures(procedures: readonly string[]): number {
    const names = new Set(procedures);
    let cancelled = 0;
    for (const job of this.listJobs()) {
      if (!names.has(job.procedure) || isTerminalStatus(job.status)) {
        continue;
      }

      requestProcedureDispatchCancellation(this.params.rootDir, job.dispatchCorrelationId);
      this.writeJob(markJobCancelled(job));
      cancelled += 1;
    }

    return cancelled;
  }

  async run(dispatchId: string): Promise<void> {
    let job = this.readJob(dispatchId);
    const timingTrace = createRunTimingTrace(this.params.rootDir, job.dispatchCorrelationId);
    appendTimingTraceEvent(timingTrace, "dispatch_worker", "run_started", {
      dispatchId,
      procedure: job.procedure,
    });
    if (job.status === "cancelled" || isProcedureDispatchCancellationRequested(this.params.rootDir, job.dispatchCorrelationId)) {
      if (job.status !== "cancelled") {
        this.writeJob(markJobCancelled(job));
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
    const stopWatchingCancellation = this.watchCancellation(dispatchId, job.dispatchCorrelationId, softStopController);
    const startedAt = new Date().toISOString();
    job = {
      ...job,
      status: "running",
      startedAt: job.startedAt ?? startedAt,
      updatedAt: startedAt,
    };
    this.writeJob(job);

    const store = this.createStore();
    let defaultAgentConfig = resolveDownstreamAgentConfig(this.params.cwd, job.defaultAgentSelection);
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
      const result = await executeTopLevelProcedure({
        cwd: this.params.cwd,
        sessionId: this.params.sessionId,
        store,
        registry,
        procedure,
        prompt: job.prompt,
        emitter,
        softStopSignal: softStopController.signal,
        getDefaultAgentConfig: () => defaultAgentConfig,
        setDefaultAgentSelection: (selection) => {
          const nextConfig = resolveDownstreamAgentConfig(this.params.cwd, selection);
          defaultAgentConfig = nextConfig;
          return nextConfig;
        },
        dispatchCorrelationId: job.dispatchCorrelationId,
        timingTrace,
      });

      const completedAt = new Date().toISOString();
      const latest = this.readJob(dispatchId);
      if (latest.status === "cancelled" || softStopController.signal.aborted) {
        this.writeJob({
          ...markJobCancelled(latest, completedAt),
          run: result.run,
          result,
          error: defaultCancellationMessage("soft_stop"),
          defaultAgentSelection: result.defaultAgentSelection ?? job.defaultAgentSelection,
        });
        return;
      }

      this.writeJob({
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
      const latest = this.readJob(dispatchId);
      const message = error instanceof Error ? error.message : String(error);
      const run = error instanceof TopLevelProcedureExecutionError || error instanceof TopLevelProcedureCancelledError
        ? error.run
        : latest.run;
      if (latest.status === "cancelled" || softStopController.signal.aborted) {
        this.writeJob({
          ...markJobCancelled(latest, completedAt),
          run,
          error: message,
        });
        return;
      }

      this.writeJob({
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
    const command = resolveSelfCommand("procedure-dispatch-worker", [
      "--session-id",
      this.params.sessionId,
      "--cwd",
      this.params.cwd,
      "--root-dir",
      this.params.rootDir,
      "--dispatch-id",
      dispatchId,
    ]);
    const child = spawn(command.command, command.args, {
      cwd: this.params.cwd,
      env: process.env,
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    return child.pid;
  }

  private touchRunningJob(dispatchId: string): void {
    const job = this.readJob(dispatchId);
    if (isTerminalStatus(job.status)) {
      return;
    }

    this.writeJob({
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
        this.writeJob(failed);
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
      this.writeJob(failed);
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
    this.writeJob(reconciled);
    return reconciled;
  }

  private tryReadStoredRunRecord(run: RunRef) {
    try {
      return this.createStore().getRun(run);
    } catch {
      return undefined;
    }
  }

  private readJob(dispatchId: string): ProcedureDispatchJob {
    const filePath = buildProcedureDispatchJobPath(this.params.rootDir, dispatchId);
    if (!existsSync(filePath)) {
      throw new Error(`Unknown procedure dispatch: ${dispatchId}`);
    }

    return JSON.parse(readFileSync(filePath, "utf8")) as ProcedureDispatchJob;
  }

  private writeJob(job: ProcedureDispatchJob): void {
    mkdirSync(this.jobsDir, { recursive: true });
    const filePath = buildProcedureDispatchJobPath(this.params.rootDir, job.dispatchId);
    const tempPath = `${filePath}.${process.pid}.tmp`;
    writeFileSync(tempPath, `${JSON.stringify(job, null, 2)}\n`, "utf8");
    renameSync(tempPath, filePath);
  }

  private writeJobWorkerPid(dispatchId: string, workerPid: number | undefined): void {
    const latest = this.readJob(dispatchId);
    this.writeJob({
      ...latest,
      workerPid: workerPid ?? latest.workerPid,
      updatedAt: latest.updatedAt,
    });
  }

  private findReusableJobByCorrelationId(
    dispatchCorrelationId: string,
    procedure: string,
    prompt: string,
  ): ProcedureDispatchJob | undefined {
    const candidates = this.listJobs()
      .filter((job) => job.dispatchCorrelationId === dispatchCorrelationId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const latest = candidates.at(-1);
    if (!latest) {
      return undefined;
    }

    if (latest.procedure !== procedure || latest.prompt !== prompt) {
      throw new Error(`Dispatch correlation id already exists for a different procedure run: ${dispatchCorrelationId}`);
    }

    return latest.status === "failed" || latest.status === "cancelled" ? undefined : latest;
  }

  private listJobs(): ProcedureDispatchJob[] {
    if (!existsSync(this.jobsDir)) {
      return [];
    }

    return readdirSync(this.jobsDir)
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) => JSON.parse(readFileSync(join(this.jobsDir, entry), "utf8")) as ProcedureDispatchJob);
  }

  private watchCancellation(
    dispatchId: string,
    dispatchCorrelationId: string,
    controller: AbortController,
  ): () => void {
    const poll = () => {
      if (controller.signal.aborted) {
        return;
      }

      const latest = this.readJob(dispatchId);
      if (
        latest.status !== "cancelled"
        && !isProcedureDispatchCancellationRequested(this.params.rootDir, dispatchCorrelationId)
      ) {
        return;
      }

      if (latest.status !== "cancelled") {
        this.writeJob(markJobCancelled(latest));
      }
      controller.abort();
    };

    poll();
    const timer = setInterval(poll, WAIT_POLL_MS);
    return () => {
      clearInterval(timer);
    };
  }
}

export function buildProcedureDispatchJobsDir(rootDir: string): string {
  return join(rootDir, PROCEDURE_DISPATCH_JOBS_DIR);
}

export function buildProcedureDispatchCancelsDir(rootDir: string): string {
  return join(rootDir, PROCEDURE_DISPATCH_CANCELS_DIR);
}

export function buildProcedureDispatchJobPath(rootDir: string, dispatchId: string): string {
  return join(buildProcedureDispatchJobsDir(rootDir), `${dispatchId}.json`);
}

export function buildProcedureDispatchCancelPath(rootDir: string, dispatchCorrelationId: string): string {
  return join(buildProcedureDispatchCancelsDir(rootDir), `${dispatchCorrelationId}.cancel`);
}

export function requestProcedureDispatchCancellation(rootDir: string, dispatchCorrelationId: string): void {
  mkdirSync(buildProcedureDispatchCancelsDir(rootDir), { recursive: true });
  const targetPath = buildProcedureDispatchCancelPath(rootDir, dispatchCorrelationId);
  const tempPath = `${targetPath}.${process.pid}.tmp`;
  writeFileSync(tempPath, `${new Date().toISOString()}\n`, "utf8");
  renameSync(tempPath, targetPath);
}

export function clearProcedureDispatchCancellation(rootDir: string, dispatchCorrelationId: string): void {
  const filePath = buildProcedureDispatchCancelPath(rootDir, dispatchCorrelationId);
  if (!existsSync(filePath)) {
    return;
  }

  unlinkSync(filePath);
}

export function isProcedureDispatchCancellationRequested(rootDir: string, dispatchCorrelationId: string): boolean {
  return existsSync(buildProcedureDispatchCancelPath(rootDir, dispatchCorrelationId));
}

export async function runProcedureDispatchWorkerCommand(argv: string[]): Promise<void> {
  const params = parseProcedureDispatchWorkerArgs(argv);
  const manager = new ProcedureDispatchJobManager({
    cwd: params.cwd,
    sessionId: params.sessionId,
    rootDir: params.rootDir,
    getRegistry: () => loadProcedureDispatchRegistry(params.cwd),
  });
  await manager.run(params.dispatchId);
}

async function loadProcedureDispatchRegistry(cwd: string): Promise<ProcedureRegistryLike> {
  const registry = new ProcedureRegistry({ cwd });
  registry.loadBuiltins();
  await registry.loadFromDisk();
  return registry;
}

function parseProcedureDispatchWorkerArgs(argv: string[]): {
  sessionId: string;
  cwd: string;
  rootDir: string;
  dispatchId: string;
} {
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let rootDir: string | undefined;
  let dispatchId: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    switch (arg) {
      case "--session-id":
        sessionId = requireValue(next, "--session-id");
        index += 1;
        break;
      case "--cwd":
        cwd = requireValue(next, "--cwd");
        index += 1;
        break;
      case "--root-dir":
        rootDir = requireValue(next, "--root-dir");
        index += 1;
        break;
      case "--dispatch-id":
        dispatchId = requireValue(next, "--dispatch-id");
        index += 1;
        break;
      default:
        throw new Error(`Unknown procedure-dispatch-worker arg: ${arg}`);
    }
  }

  if (!sessionId) {
    throw new Error("Missing required arg: --session-id");
  }

  if (!cwd) {
    throw new Error("Missing required arg: --cwd");
  }

  if (!rootDir) {
    throw new Error("Missing required arg: --root-dir");
  }

  if (!dispatchId) {
    throw new Error("Missing required arg: --dispatch-id");
  }

  return { sessionId, cwd, rootDir, dispatchId };
}

function clampWaitMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_WAIT_MS;
  }

  return Math.min(Math.max(Math.floor(value), 1), MAX_WAIT_MS);
}

function isTerminalStatus(status: ProcedureDispatchJobStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function isDeadWorkerJob(job: ProcedureDispatchJob): boolean {
  return (
    (job.status === "queued" || job.status === "running") &&
    typeof job.workerPid === "number" &&
    job.workerPid > 0 &&
    !isProcessAlive(job.workerPid)
  );
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

function looksLikeProcedureFailureRecord(record: RunRecord): boolean {
  return (
    record.output.data === undefined &&
    record.output.display === undefined &&
    record.output.memory === undefined &&
    typeof record.output.summary === "string" &&
    /^Error:/i.test(record.output.summary)
  );
}

function toProcedureDispatchStatusResult(job: ProcedureDispatchJob): ProcedureDispatchStatusResult {
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

function markJobCancelled(
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
