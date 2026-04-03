#!/usr/bin/env bun
import {
  deleteCleanupCandidates,
  getSessionCleanupBaseDir,
  inspectSessionCleanupCandidates,
  selectCleanupCandidates,
  summarizeCleanupCandidates,
  type SessionCleanupReason,
} from "../src/session-cleanup.ts";

const ALL_REASONS: SessionCleanupReason[] = [
  "empty_dir",
  "empty_session",
  "unknown_cwd",
  "temp_cwd",
  "fixture_session_id",
  "fixture_prompt",
];

const args = parseArgs(Bun.argv.slice(2));
const baseDir = args.baseDir ?? getSessionCleanupBaseDir();
const reasons = args.reasons.length > 0 ? args.reasons : [
  "empty_dir",
  "empty_session",
  "temp_cwd",
  "fixture_session_id",
  "fixture_prompt",
];

const candidates = inspectSessionCleanupCandidates(baseDir);
const selected = selectCleanupCandidates(candidates, reasons)
  .filter((candidate) => args.keepCwds.length === 0 || !candidate.cwd || !args.keepCwds.includes(candidate.cwd));

if (args.json) {
  process.stdout.write(`${JSON.stringify({
    baseDir,
    reasons,
    summary: summarizeCleanupCandidates(selected),
    sessions: selected,
  }, null, 2)}\n`);
} else {
  printSummary(baseDir, reasons, selected, args.limit);
}

if (args.apply) {
  const { deleted } = deleteCleanupCandidates(selected);
  process.stdout.write(`\nDeleted ${deleted.length} session director${deleted.length === 1 ? "y" : "ies"}.\n`);
}

function printSummary(
  baseDir: string,
  reasons: SessionCleanupReason[],
  sessions: ReturnType<typeof selectCleanupCandidates>,
  limit: number,
): void {
  process.stdout.write(`Scanning ${baseDir}\n`);
  process.stdout.write(`Selected reasons: ${reasons.join(", ")}\n`);
  process.stdout.write(`Matches: ${sessions.length}\n\n`);

  const byReason = summarizeCleanupCandidates(sessions);
  for (const reason of ALL_REASONS) {
    if (byReason[reason] > 0) {
      process.stdout.write(`- ${reason}: ${byReason[reason]}\n`);
    }
  }

  process.stdout.write("\nCandidates:\n");
  for (const candidate of sessions.slice(0, limit)) {
    const prompt = candidate.initialPrompt?.replace(/\s+/g, " ").trim() || "(no prompt)";
    const cwd = candidate.cwd || "(cwd unknown)";
    process.stdout.write([
      `* ${candidate.sessionId}`,
      `  reasons: ${candidate.reasons.join(", ")}`,
      `  cwd: ${cwd}`,
      `  prompt: ${prompt}`,
      `  cells/jobs: ${candidate.cellCount}/${candidate.jobCount}`,
      `  updated: ${candidate.updatedAt ?? "unknown"}`,
    ].join("\n") + "\n");
  }

  if (sessions.length > limit) {
    process.stdout.write(`... ${sessions.length - limit} more candidate(s) omitted; use --limit to raise the cap.\n`);
  }

  if (!args.apply) {
    process.stdout.write("\nDry run only. Re-run with --apply to delete the listed session directories.\n");
  }
}

function parseArgs(argv: string[]): {
  apply: boolean;
  json: boolean;
  baseDir?: string;
  reasons: SessionCleanupReason[];
  limit: number;
  keepCwds: string[];
} {
  let apply = false;
  let json = false;
  let baseDir: string | undefined;
  let reasons: SessionCleanupReason[] = [];
  let limit = 100;
  const keepCwds: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    switch (arg) {
      case "--apply":
        apply = true;
        break;
      case "--json":
        json = true;
        break;
      case "--base-dir":
        baseDir = requireValue(next, arg);
        index += 1;
        break;
      case "--reasons":
        reasons = parseReasons(requireValue(next, arg));
        index += 1;
        break;
      case "--limit":
        limit = Number(requireValue(next, arg));
        index += 1;
        break;
      case "--keep-cwd":
        keepCwds.push(requireValue(next, arg));
        index += 1;
        break;
      case "-h":
      case "--help":
        printHelp();
        process.exit(0);
      default:
        throw new Error(`Unknown arg: ${arg}`);
    }
  }

  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error(`Invalid --limit: ${limit}`);
  }

  return { apply, json, baseDir, reasons, limit: Math.floor(limit), keepCwds };
}

function parseReasons(value: string): SessionCleanupReason[] {
  const parsed = value.split(",").map((item) => item.trim()).filter(Boolean) as SessionCleanupReason[];
  for (const reason of parsed) {
    if (!ALL_REASONS.includes(reason)) {
      throw new Error(`Unknown cleanup reason: ${reason}`);
    }
  }
  return parsed;
}

function requireValue(value: string | undefined, flag: string): string {
  if (!value) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function printHelp(): void {
  process.stdout.write([
    "Usage: bun run scripts/cleanup-sessions.ts [options]",
    "",
    "Inspects ~/.nanoboss/sessions and identifies suspicious test/empty sessions.",
    "Dry-run by default; pass --apply to actually delete matched directories.",
    "",
    "Options:",
    "  --apply                    Delete matched session directories",
    "  --json                     Emit machine-readable JSON",
    "  --base-dir <path>          Inspect a different sessions directory",
    `  --reasons <csv>            Reasons to select (${ALL_REASONS.join(", ")})`,
    "  --keep-cwd <cwd>           Exclude sessions for this cwd (repeatable)",
    "  --limit <n>                Max candidates to print in text mode (default: 100)",
    "  -h, --help                 Show this help text",
    "",
    "Examples:",
    "  bun run scripts/cleanup-sessions.ts",
    "  bun run scripts/cleanup-sessions.ts --reasons empty_dir,empty_session,temp_cwd,fixture_session_id,fixture_prompt",
    "  bun run scripts/cleanup-sessions.ts --keep-cwd /Users/jflam/agentboss/workspaces/nanoboss",
    "  bun run scripts/cleanup-sessions.ts --apply --reasons empty_dir,empty_session,temp_cwd,fixture_session_id,fixture_prompt",
    "",
  ].join("\n"));
}
