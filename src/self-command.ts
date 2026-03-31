export interface SelfCommand {
  command: string;
  args: string[];
}

export function resolveSelfCommand(subcommand: string, args: string[] = []): SelfCommand {
  const executable = process.execPath;
  const scriptPath = process.argv[1];

  if (scriptPath && scriptPath !== executable && /\.[cm]?[jt]sx?$/i.test(scriptPath)) {
    return {
      command: executable,
      args: [scriptPath, subcommand, ...args],
    };
  }

  return {
    command: executable,
    args: [subcommand, ...args],
  };
}
