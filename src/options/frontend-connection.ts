import { DEFAULT_HTTP_SERVER_URL } from "../defaults.ts";
import { requireValue } from "../util/argv.ts";

export interface FrontendConnectionOptions {
  showToolCalls: boolean;
  showHelp: boolean;
  serverUrl: string;
}

export interface ParsedFrontendConnectionOptions extends FrontendConnectionOptions {
  remainingArgs: string[];
}

export function parseFrontendConnectionOptions(argv: string[]): ParsedFrontendConnectionOptions {
  let showToolCalls = true;
  let showHelp = false;
  let serverUrl = Bun.env.NANOBOSS_SERVER_URL ?? DEFAULT_HTTP_SERVER_URL;
  const remainingArgs: string[] = [];

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
        serverUrl = requireValue(argv[index + 1], "--server-url");
        index += 1;
        break;
      case "-h":
      case "--help":
        showHelp = true;
        break;
      default:
        if (arg.startsWith("--server-url=")) {
          serverUrl = requireValue(arg.slice("--server-url=".length), "--server-url");
          break;
        }

        remainingArgs.push(arg);
        break;
    }
  }

  return {
    showToolCalls,
    showHelp,
    serverUrl,
    remainingArgs,
  };
}
