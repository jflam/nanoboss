import { promptForStoredSessionSelection } from "./src/tui/overlays/session-picker.ts";
import { createNanobossTuiTheme } from "./src/tui/theme.ts";
import { assertInteractiveTty, runTuiCli } from "./src/tui/run.ts";
import { DEFAULT_HTTP_SERVER_URL } from "./src/defaults.ts";
import { parseResumeOptions } from "./src/resume-options.ts";
import {
  findSessionSummary,
  listSessionSummaries,
  readCurrentSessionMetadata,
  resolveMostRecentSessionSummary,
  toSessionSummary,
  type SessionSummary,
} from "./src/session/persistence.ts";

export type StoredSessionSelectionResult =
  | { kind: "selected"; session: SessionSummary }
  | { kind: "cancelled" }
  | { kind: "empty" };

export async function runResumeCommand(
  argv: string[] = [],
  deps: {
    assertInteractiveTty?: typeof assertInteractiveTty;
    runTuiCli?: typeof runTuiCli;
    selectStoredSession?: (cwd: string) => Promise<StoredSessionSelectionResult>;
  } = {},
): Promise<void> {
  const options = parseResumeOptions(argv);
  if (options.showHelp) {
    printHelp();
    return;
  }

  const cwd = process.cwd();
  (deps.assertInteractiveTty ?? assertInteractiveTty)("resume");

  let selected: SessionSummary | undefined;
  if (options.sessionId) {
    selected = resolveExplicitSession(options.sessionId);
  } else if (options.list) {
    const selection = await (deps.selectStoredSession ?? selectStoredSession)(cwd);
    if (selection.kind === "cancelled") {
      return;
    }
    if (selection.kind === "empty") {
      throw new Error(`No saved nanoboss sessions found for ${cwd}`);
    }
    selected = selection.session;
  } else {
    selected = resolveDefaultSession(cwd);
  }

  if (!selected) {
    if (options.sessionId) {
      throw new Error(`Unknown session: ${options.sessionId}`);
    }
    throw new Error(`No saved nanoboss sessions found for ${cwd}`);
  }

  await (deps.runTuiCli ?? runTuiCli)({
    serverUrl: options.serverUrl,
    showToolCalls: options.showToolCalls,
    sessionId: selected.sessionId,
  });
}

function resolveExplicitSession(sessionId: string): SessionSummary | undefined {
  return findSessionSummary(sessionId);
}

function resolveDefaultSession(cwd: string): SessionSummary | undefined {
  const current = readCurrentSessionMetadata();
  if (current && current.cwd === cwd) {
    return toSessionSummary(current);
  }

  return resolveMostRecentSessionSummary(cwd);
}

async function selectStoredSession(cwd: string): Promise<StoredSessionSelectionResult> {
  const sessions = orderSessions(cwd, withCurrentSession(cwd, listSessionSummaries()));
  if (sessions.length === 0) {
    return { kind: "empty" };
  }

  const selected = await promptForStoredSessionSelection(createNanobossTuiTheme(), sessions, cwd);
  return selected
    ? { kind: "selected", session: selected }
    : { kind: "cancelled" };
}

function withCurrentSession(cwd: string, sessions: SessionSummary[]): SessionSummary[] {
  const current = readCurrentSessionMetadata();
  if (!current || current.cwd !== cwd || sessions.some((session) => session.sessionId === current.sessionId)) {
    return sessions;
  }

  return [
    toSessionSummary(current),
    ...sessions,
  ];
}

function orderSessions(cwd: string, sessions: SessionSummary[]): SessionSummary[] {
  return [...sessions].sort((left, right) => {
    const cwdRank = Number(right.cwd === cwd) - Number(left.cwd === cwd);
    if (cwdRank !== 0) {
      return cwdRank;
    }

    return right.updatedAt.localeCompare(left.updatedAt);
  });
}

function printHelp(): void {
  process.stdout.write([
    "Usage: nanoboss resume [session-id] [--list] [--tool-calls|--no-tool-calls] [--server-url <url>]",
    "",
    "Requires an interactive TTY. For automation, use nanoboss http, mcp, or acp-server.",
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
