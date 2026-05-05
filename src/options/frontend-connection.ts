import type { FrontendConnectionMode } from "@nanoboss/adapters-tui";
import { requireValue } from "../util/argv.ts";

export interface FrontendConnectionOptions {
  showToolCalls: boolean;
  simplify2AutoApprove: boolean;
  showHelp: boolean;
  connectionMode: FrontendConnectionMode;
  serverUrl?: string;
}

interface ParsedFrontendConnectionOptions extends FrontendConnectionOptions {
  remainingArgs: string[];
}

export function parseFrontendConnectionOptions(argv: string[]): ParsedFrontendConnectionOptions {
  let showToolCalls = true;
  let simplify2AutoApprove = false;
  let showHelp = false;
  let serverUrl = normalizeServerUrl(Bun.env.NANOBOSS_SERVER_URL);
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
      case "--simplify2-auto-approve":
        simplify2AutoApprove = true;
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
    simplify2AutoApprove,
    showHelp,
    connectionMode: serverUrl ? "external" : "private",
    serverUrl,
    remainingArgs,
  };
}

function normalizeServerUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
