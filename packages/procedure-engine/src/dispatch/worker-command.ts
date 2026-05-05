import { ProcedureRegistry } from "@nanoboss/procedure-catalog";
import type { ProcedureRegistryLike } from "@nanoboss/procedure-sdk";

import { ProcedureDispatchJobManager } from "./jobs.ts";
import { parseProcedureDispatchWorkerArgs } from "./worker-args.ts";

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
