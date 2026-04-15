import {
  assertInteractiveTty,
  createNanobossTuiTheme,
  promptForStoredSessionSelection,
  runTuiCli,
} from "@nanoboss/adapters-tui";
import type { SessionMetadata } from "@nanoboss/contracts";
import { parseResumeOptions } from "./src/options/resume.ts";
import {
  listStoredSessions,
  readCurrentWorkspaceSessionMetadata,
} from "@nanoboss/store";

export type StoredSessionSelectionResult =
  | { kind: "selected"; session: SessionMetadata }
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

  let selected: SessionMetadata | undefined;
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
    cwd: selected.cwd,
    connectionMode: options.connectionMode,
    serverUrl: options.serverUrl,
    showToolCalls: options.showToolCalls,
    simplify2AutoApprove: options.simplify2AutoApprove,
    sessionId: selected.session.sessionId,
  });
}

function resolveExplicitSession(sessionId: string): SessionMetadata | undefined {
  return listStoredSessions().find((session) => session.session.sessionId === sessionId);
}

function resolveDefaultSession(cwd: string): SessionMetadata | undefined {
  const sessions = listStoredSessions();
  const currentSessionId = readCurrentWorkspaceSessionMetadata(cwd)?.session.sessionId;
  if (currentSessionId) {
    const current = sessions.find((session) => session.session.sessionId === currentSessionId);
    if (current) {
      return current;
    }
  }

  return sessions.find((session) => session.cwd === cwd);
}

async function selectStoredSession(cwd: string): Promise<StoredSessionSelectionResult> {
  const sessions = orderSessions(cwd, listStoredSessions());
  if (sessions.length === 0) {
    return { kind: "empty" };
  }

  const selected = await promptForStoredSessionSelection(createNanobossTuiTheme(), sessions, cwd);
  return selected
    ? { kind: "selected", session: selected }
    : { kind: "cancelled" };
}

function orderSessions(cwd: string, sessions: SessionMetadata[]): SessionMetadata[] {
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
    "Usage: nanoboss resume [session-id] [--list] [--tool-calls|--no-tool-calls] [--simplify2-auto-approve] [--server-url <url>]",
    "",
    "Requires an interactive TTY. For automation, use nanoboss http, mcp, or acp-server.",
    "",
    "Options:",
    "  --list                Choose from saved sessions before resuming",
    "  --tool-calls          Show tool call progress lines (default)",
    "  --no-tool-calls       Hide tool call progress lines",
    "  --simplify2-auto-approve",
    "                        Auto-approve simplify2 checkpoints in the TUI",
    "  --server-url <url>    Connect to an existing nanoboss HTTP/SSE server",
    "                        (default: start a private local server)",
    "  -h, --help            Show this help text",
    "",
  ].join("\n"));
}
