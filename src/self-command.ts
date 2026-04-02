import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export interface SelfCommand {
  command: string;
  args: string[];
}

export function resolveSelfCommand(subcommand: string, args: string[] = []): SelfCommand {
  const executable = process.execPath;
  const scriptPath = process.argv[1];

  if (scriptPath && scriptPath !== executable && /\.[cm]?[jt]sx?$/i.test(scriptPath)) {
    // Always resolve to nanoboss.ts, not process.argv[1]. When test scripts or other
    // entry points instantiate NanobossService directly, process.argv[1] points to
    // the caller rather than nanoboss.ts, which is the only entry point that implements
    // full subcommand dispatch.
    const nanobossScript = resolve(dirname(fileURLToPath(import.meta.url)), "..", "nanoboss.ts");
    return {
      command: executable,
      args: [nanobossScript, subcommand, ...args],
    };
  }

  return {
    command: executable,
    args: [subcommand, ...args],
  };
}
