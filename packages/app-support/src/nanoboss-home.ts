import { homedir } from "node:os";
import { join } from "node:path";

export function getNanobossHome(): string {
  return join(process.env.HOME?.trim() || homedir(), ".nanoboss");
}

export function getNanobossRuntimeDir(): string {
  return join(getNanobossHome(), "runtime");
}
