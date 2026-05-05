import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  buildProcedureDispatchJobPath,
  buildProcedureDispatchJobsDir,
} from "./files.ts";
import type { ProcedureDispatchJob } from "./jobs.ts";

export class ProcedureDispatchJobStore {
  private readonly jobsDir: string;

  constructor(private readonly rootDir: string) {
    this.jobsDir = buildProcedureDispatchJobsDir(rootDir);
  }

  read(dispatchId: string): ProcedureDispatchJob {
    const filePath = buildProcedureDispatchJobPath(this.rootDir, dispatchId);
    if (!existsSync(filePath)) {
      throw new Error(`Unknown procedure dispatch: ${dispatchId}`);
    }

    return JSON.parse(readFileSync(filePath, "utf8")) as ProcedureDispatchJob;
  }

  write(job: ProcedureDispatchJob): void {
    mkdirSync(this.jobsDir, { recursive: true });
    const filePath = buildProcedureDispatchJobPath(this.rootDir, job.dispatchId);
    const tempPath = `${filePath}.${process.pid}.tmp`;
    writeFileSync(tempPath, `${JSON.stringify(job, null, 2)}\n`, "utf8");
    renameSync(tempPath, filePath);
  }

  writeWorkerPid(dispatchId: string, workerPid: number | undefined): void {
    const latest = this.read(dispatchId);
    this.write({
      ...latest,
      workerPid: workerPid ?? latest.workerPid,
      updatedAt: latest.updatedAt,
    });
  }

  list(): ProcedureDispatchJob[] {
    if (!existsSync(this.jobsDir)) {
      return [];
    }

    return readdirSync(this.jobsDir)
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) => JSON.parse(readFileSync(join(this.jobsDir, entry), "utf8")) as ProcedureDispatchJob);
  }

  findReusableByCorrelationId(
    dispatchCorrelationId: string,
    procedure: string,
    prompt: string,
  ): ProcedureDispatchJob | undefined {
    const candidates = this.list()
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
}
