import {
  parseFrontendConnectionOptions,
  type FrontendConnectionOptions,
} from "./frontend-connection.ts";

interface ResumeOptions extends FrontendConnectionOptions {
  list: boolean;
  sessionId?: string;
}

export function parseResumeOptions(argv: string[]): ResumeOptions {
  const {
    remainingArgs,
    ...frontend
  } = parseFrontendConnectionOptions(argv);
  let list = false;
  let sessionId: string | undefined;

  for (const arg of remainingArgs) {
    if (!arg) {
      continue;
    }

    switch (arg) {
      case "--list":
        list = true;
        break;
      default:
        if (!arg.startsWith("-") && !sessionId) {
          sessionId = arg;
        }
        break;
    }
  }

  return {
    ...frontend,
    list,
    sessionId,
  };
}
