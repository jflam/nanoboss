import { spawn } from "node:child_process";

import { resolveSelfCommand } from "@nanoboss/app-support";

export function spawnProcedureDispatchWorker(params: {
  cwd: string;
  sessionId: string;
  rootDir: string;
  dispatchId: string;
}): number | undefined {
  const command = resolveSelfCommand("procedure-dispatch-worker", [
    "--session-id",
    params.sessionId,
    "--cwd",
    params.cwd,
    "--root-dir",
    params.rootDir,
    "--dispatch-id",
    params.dispatchId,
  ]);
  const child = spawn(command.command, command.args, {
    cwd: params.cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return child.pid;
}
