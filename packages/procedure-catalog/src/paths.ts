import { homedir } from "node:os";
import { join } from "node:path";

function getNanobossHome(): string {
  return join(process.env.HOME?.trim() || homedir(), ".nanoboss");
}

export function getProcedureRuntimeDir(): string {
  return join(getNanobossHome(), "runtime");
}
