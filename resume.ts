import readline from "node:readline/promises";

import { runLegacyHttpCli } from "./src/http-cli-legacy.ts";
import { promptForStoredSessionSelection } from "./src/tui/overlays/session-picker.ts";
import { createNanobossTuiTheme } from "./src/tui/theme.ts";
import { canUseNanobossTui, runTuiCli } from "./src/tui/run.ts";
import { readCurrentSessionPointer } from "./src/current-session.ts";
import { DEFAULT_HTTP_SERVER_URL } from "./src/defaults.ts";
import { parseResumeOptions } from "./src/resume-options.ts";
import { formatSessionDetailLine, formatSessionLine } from "./src/session-picker-format.ts";
import {
  findStoredSession,
  listStoredSessions,
  resolveMostRecentStoredSession,
  type StoredSessionSummary,
} from "./src/stored-sessions.ts";

export async function runResumeCommand(argv: string[] = []): Promise<void> {
  const options = parseResumeOptions(argv);
  if (options.showHelp) {
    printHelp();
    return;
  }

  const selected = options.sessionId
    ? resolveExplicitSession(options.sessionId)
    : options.list
      ? await selectStoredSession(process.cwd())
      : resolveDefaultSession(process.cwd());

  if (!selected) {
    throw new Error(`No saved nanoboss sessions found for ${process.cwd()}`);
  }

  if (canUseNanobossTui()) {
    await runTuiCli({
      serverUrl: options.serverUrl,
      showToolCalls: options.showToolCalls,
      sessionId: selected.sessionId,
    });
    return;
  }

  await runLegacyHttpCli({
    serverUrl: options.serverUrl,
    showToolCalls: options.showToolCalls,
    sessionId: selected.sessionId,
  });
}

function resolveExplicitSession(sessionId: string): StoredSessionSummary {
  return findStoredSession(sessionId) ?? {
    sessionId,
    cwd: process.cwd(),
    rootDir: "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    hasMetadata: false,
    hasNativeResume: false,
  };
}

function resolveDefaultSession(cwd: string): StoredSessionSummary | undefined {
  const pointer = readCurrentSessionPointer();
  if (pointer?.sessionId && pointer.cwd === cwd) {
    return findStoredSession(pointer.sessionId) ?? {
      sessionId: pointer.sessionId,
      cwd: pointer.cwd,
      rootDir: pointer.rootDir,
      createdAt: pointer.updatedAt,
      updatedAt: pointer.updatedAt,
      hasMetadata: false,
      hasNativeResume: false,
    };
  }

  return resolveMostRecentStoredSession(cwd);
}

async function selectStoredSession(cwd: string): Promise<StoredSessionSummary | undefined> {
  const sessions = orderSessions(cwd, withCurrentPointerSession(cwd, listStoredSessions()));
  if (sessions.length === 0) {
    return undefined;
  }

  if (canUseNanobossTui()) {
    return await promptForStoredSessionSelection(createNanobossTuiTheme(), sessions, cwd);
  }

  return await selectStoredSessionByNumber(sessions, cwd);
}

function withCurrentPointerSession(cwd: string, sessions: StoredSessionSummary[]): StoredSessionSummary[] {
  const pointer = readCurrentSessionPointer();
  if (!pointer?.sessionId || pointer.cwd !== cwd || sessions.some((session) => session.sessionId === pointer.sessionId)) {
    return sessions;
  }

  return [
    {
      sessionId: pointer.sessionId,
      cwd: pointer.cwd,
      rootDir: pointer.rootDir,
      createdAt: pointer.updatedAt,
      updatedAt: pointer.updatedAt,
      hasMetadata: false,
      hasNativeResume: false,
    },
    ...sessions,
  ];
}

function orderSessions(cwd: string, sessions: StoredSessionSummary[]): StoredSessionSummary[] {
  return [...sessions].sort((left, right) => {
    const cwdRank = Number(right.cwd === cwd) - Number(left.cwd === cwd);
    if (cwdRank !== 0) {
      return cwdRank;
    }

    return right.updatedAt.localeCompare(left.updatedAt);
  });
}

async function selectStoredSessionByNumber(
  sessions: StoredSessionSummary[],
  cwd: string,
): Promise<StoredSessionSummary | undefined> {
  process.stderr.write(`Saved nanoboss sessions for ${cwd}\n\n`);
  for (const [index, session] of sessions.entries()) {
    process.stderr.write(`${index + 1}. ${formatSessionLine(session, cwd)}\n`);
    process.stderr.write(`   ${formatSessionDetailLine(session)}\n`);
  }
  process.stderr.write("\n");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });

  try {
    for (;;) {
      const raw = (await rl.question("Select session number: ")).trim();
      if (!raw) {
        return undefined;
      }

      const selection = Number(raw);
      if (Number.isInteger(selection) && selection >= 1 && selection <= sessions.length) {
        return sessions[selection - 1];
      }

      process.stderr.write(`Invalid selection: ${raw}\n`);
    }
  } finally {
    rl.close();
  }
}

function printHelp(): void {
  process.stdout.write([
    "Usage: nanoboss resume [session-id] [--list] [--tool-calls|--no-tool-calls] [--server-url <url>]",
    "",
    "Options:",
    "  --list                Choose from saved sessions before resuming",
    "  --tool-calls          Show tool call progress lines (default)",
    "  --no-tool-calls       Hide tool call progress lines",
    `  --server-url <url>    Connect to nanoboss over HTTP/SSE (default: ${DEFAULT_HTTP_SERVER_URL})`,
    "  -h, --help            Show this help text",
    "",
  ].join("\n"));
}

if (import.meta.main) {
  await runResumeCommand(Bun.argv.slice(2));
}
