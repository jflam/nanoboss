export interface CliOptions {
  showToolCalls: boolean;
  showHelp: boolean;
}

export function parseCliOptions(argv: string[]): CliOptions {
  let showToolCalls = true;
  let showHelp = false;

  for (const arg of argv) {
    switch (arg) {
      case "--tool-calls":
        showToolCalls = true;
        break;
      case "--no-tool-calls":
        showToolCalls = false;
        break;
      case "-h":
      case "--help":
        showHelp = true;
        break;
      default:
        break;
    }
  }

  return {
    showToolCalls,
    showHelp,
  };
}
