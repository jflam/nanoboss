import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface InstallPathOptions {
  homeDir?: string;
  overrideDir?: string;
  pathEnv?: string;
}

export function resolveNanobossInstallDir(options: InstallPathOptions = {}): string {
  const homeDir = options.homeDir ?? homedir();
  const overrideDir = options.overrideDir?.trim();
  if (overrideDir) {
    return resolve(expandHome(overrideDir, homeDir));
  }

  const entries = splitPath(options.pathEnv ?? process.env.PATH ?? "", homeDir);
  const preferred = [
    join(homeDir, ".local/bin"),
    join(homeDir, "bin"),
    join(homeDir, ".bun/bin"),
  ];

  for (const candidate of preferred) {
    if (entries.includes(candidate)) {
      return candidate;
    }
  }

  for (const entry of entries) {
    if (entry.startsWith(homeDir)) {
      return entry;
    }
  }

  return join(homeDir, ".local/bin");
}

export function splitPath(pathEnv: string, homeDir: string): string[] {
  return pathEnv
    .split(":")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => resolve(expandHome(entry, homeDir)));
}

function expandHome(value: string, homeDir: string): string {
  if (value === "~") {
    return homeDir;
  }

  if (value.startsWith("~/")) {
    return join(homeDir, value.slice(2));
  }

  return value;
}
