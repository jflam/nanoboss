import type { Procedure, ProcedureRegistryLike } from "@nanoboss/procedure-sdk";

export interface LoadableProcedureRegistry extends ProcedureRegistryLike {
  loadProcedureFromPath(path: string): Promise<Procedure>;
  persist(procedureName: string, source: string, cwd: string): Promise<string>;
}

export function assertProcedureSupportsResume(
  procedure: Procedure,
): asserts procedure is Procedure & { resume: NonNullable<Procedure["resume"]> } {
  if (!procedure.resume) {
    throw new Error(`Procedure /${procedure.name} does not support continuation.`);
  }
}
