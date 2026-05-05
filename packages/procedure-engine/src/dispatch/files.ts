import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PROCEDURE_DISPATCH_JOBS_DIR = "procedure-dispatch-jobs";
const PROCEDURE_DISPATCH_CANCELS_DIR = "procedure-dispatch-cancels";

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
