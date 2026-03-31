export interface CliOptions {
  showToolCalls: boolean;
  showHelp: boolean;
  serverUrl?: string;
}

export function parseCliOptions(argv: string[]): CliOptions {
  let showToolCalls = true;
  let showHelp = false;
  let serverUrl: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) {
      continue;
    }

    switch (arg) {
      case "--tool-calls":
        showToolCalls = true;
        break;
      case "--no-tool-calls":
        showToolCalls = false;
        break;
      case "--server-url":
        serverUrl = argv[index + 1];
        index += 1;
        break;
      case "-h":
      case "--help":
        showHelp = true;
        break;
      default:
        if (arg.startsWith("--server-url=")) {
          serverUrl = arg.slice("--server-url=".length);
        }
        break;
    }
  }

  return {
    showToolCalls,
    showHelp,
    serverUrl,
  };
}
