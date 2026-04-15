import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { readStoredSessionMetadata } from "@nanoboss/store";
import { getNanobossHome } from "../core/config.ts";
import { formatErrorMessage } from "../core/error-format.ts";

export type SessionCleanupReason =
  | "empty_dir"
  | "empty_session"
  | "unknown_cwd"
  | "temp_cwd"
  | "fixture_session_id"
  | "fixture_prompt";

export interface SessionCleanupCandidate {
  sessionId: string;
  rootDir: string;
  cwd?: string;
  initialPrompt?: string;
  updatedAt?: string;
  createdAt?: string;
  cellCount: number;
  jobCount: number;
  hasSessionJson: boolean;
  reasons: SessionCleanupReason[];
}

const DEFAULT_DELETE_REASONS: SessionCleanupReason[] = [
  "empty_dir",
  "empty_session",
  "temp_cwd",
  "fixture_session_id",
  "fixture_prompt",
];

const FIXTURE_PROMPTS = new Set([
  "what is 2+2",
  "What is 2 + 2? Reply with only the number.",
  "add 3 to result",
  "add 4",
  "first 3 prime numbers",
  "markdown demo",
  "nested tool trace demo",
  "simulate-long-run",
  "hello",
  "do you have any mcp servers available",
  "what mcp servers are available",
  "what mcp servers do you see",
  "write fizzbuzz in python",
  "/tokens",
  "/probe",
  "/review patch",
  "/review the code",
  "/slowreview patch",
  "/model claude opus",
  "/model copilot gpt-5.4/high",
  "/model copilot gpt-5.4/xhigh",
]);

const FIXTURE_PROMPT_PREFIXES = [
  "/second-opinion What is 2 + 2? Reply with only the number.",
  "/second-opinion Review this TypeScript function.",
  "/research how to write fizzbuzz",
  "/research how acp protocol is used by nanoboss",
  "/research how mcp protocol is used by nanoboss",
  "/research what is 2+2",
  "/research how does nanoboss use mcp",
  "/research how the new mcp server implementation works in nanoboss",
  "/research how we use typia to enforce types in ctx.agent.run() calls in nanoboss procedures",
];

export function getSessionCleanupBaseDir(): string {
  return join(getNanobossHome(), "sessions");
}

export function inspectSessionCleanupCandidates(baseDir = getSessionCleanupBaseDir()): SessionCleanupCandidate[] {
  if (!existsSync(baseDir)) {
    return [];
  }

  return readdirSync(baseDir)
    .map((entry) => join(baseDir, entry))
    .filter((path) => statSync(path, { throwIfNoEntry: false })?.isDirectory())
    .map((rootDir) => inspectSessionDirectory(rootDir))
    .filter((candidate): candidate is SessionCleanupCandidate => candidate !== undefined)
    .sort((left, right) => (left.updatedAt ?? "").localeCompare(right.updatedAt ?? "") || left.sessionId.localeCompare(right.sessionId));
}

export function selectCleanupCandidates(
  candidates: SessionCleanupCandidate[],
  reasons = DEFAULT_DELETE_REASONS,
): SessionCleanupCandidate[] {
  const wanted = new Set(reasons);
  return candidates.filter((candidate) => candidate.reasons.some((reason) => wanted.has(reason)));
}

export function deleteCleanupCandidates(candidates: SessionCleanupCandidate[]): { deleted: string[] } {
  const deleted: string[] = [];
  for (const candidate of candidates) {
    rmSync(candidate.rootDir, { recursive: true, force: true });
    deleted.push(candidate.sessionId);
  }
  return { deleted };
}

export function summarizeCleanupCandidates(candidates: SessionCleanupCandidate[]): Record<SessionCleanupReason, number> {
  const summary = {
    empty_dir: 0,
    empty_session: 0,
    unknown_cwd: 0,
    temp_cwd: 0,
    fixture_session_id: 0,
    fixture_prompt: 0,
  } satisfies Record<SessionCleanupReason, number>;

  for (const candidate of candidates) {
    for (const reason of candidate.reasons) {
      summary[reason] += 1;
    }
  }

  return summary;
}

function inspectSessionDirectory(rootDir: string): SessionCleanupCandidate | undefined {
  const sessionId = rootDir.split("/").at(-1) ?? rootDir;
  const sessionJsonPath = join(rootDir, "session.json");
  const cellsDir = join(rootDir, "cells");
  const jobsDir = join(rootDir, "procedure-dispatch-jobs");
  const hasSessionJson = existsSync(sessionJsonPath);
  let metadata;
  try {
    metadata = readStoredSessionMetadata(sessionId, rootDir);
  } catch (error) {
    console.warn(`Ignoring unreadable session metadata at ${sessionJsonPath}: ${formatErrorMessage(error)}`);
  }
  const partialMetadata = metadata ?? readPartialSessionMetadata(sessionJsonPath);
  const cellCount = countJsonFiles(cellsDir);
  const jobCount = countJsonFiles(jobsDir);
  const cwd = metadata?.cwd ?? partialMetadata?.cwd;
  const initialPrompt = metadata?.initialPrompt ?? partialMetadata?.initialPrompt;
  const reasons = classifyCleanupReasons({
    sessionId: metadata?.session.sessionId ?? sessionId,
    cwd,
    initialPrompt,
    hasSessionJson,
    cellCount,
    jobCount,
    rootDir,
  });

  if (reasons.length === 0) {
    return undefined;
  }

  return {
    sessionId,
    rootDir,
    cwd,
    initialPrompt,
    updatedAt: metadata?.updatedAt ?? partialMetadata?.updatedAt,
    createdAt: metadata?.createdAt ?? partialMetadata?.createdAt,
    cellCount,
    jobCount,
    hasSessionJson,
    reasons,
  };
}

function classifyCleanupReasons(params: {
  sessionId: string;
  cwd?: string;
  initialPrompt?: string;
  hasSessionJson: boolean;
  cellCount: number;
  jobCount: number;
  rootDir: string;
}): SessionCleanupReason[] {
  const reasons: SessionCleanupReason[] = [];

  if (!params.hasSessionJson && params.cellCount === 0 && params.jobCount === 0 && isDirectoryEmpty(params.rootDir)) {
    reasons.push("empty_dir");
  }

  if (params.hasSessionJson && !hasText(params.initialPrompt) && params.cellCount === 0 && params.jobCount === 0) {
    reasons.push("empty_session");
  }

  if (!hasText(params.cwd)) {
    reasons.push("unknown_cwd");
  }

  if (looksLikeTempCwd(params.cwd)) {
    reasons.push("temp_cwd");
  }

  if (looksLikeFixtureSessionId(params.sessionId)) {
    reasons.push("fixture_session_id");
  }

  if (looksLikeFixturePrompt(params.initialPrompt)) {
    reasons.push("fixture_prompt");
  }

  return reasons;
}

function countJsonFiles(dir: string): number {
  if (!existsSync(dir)) {
    return 0;
  }

  try {
    return readdirSync(dir).filter((entry) => entry.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

function isDirectoryEmpty(dir: string): boolean {
  try {
    return readdirSync(dir).length === 0;
  } catch {
    return false;
  }
}

function hasText(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function looksLikeTempCwd(cwd: string | undefined): boolean {
  if (!hasText(cwd)) {
    return false;
  }

  const value = cwd.trim();
  return (
    value.startsWith("/tmp/") ||
    value.startsWith("/private/tmp/") ||
    value.startsWith("/var/folders/") ||
    value.includes("/T/nab-") ||
    value.includes("/T/repro-") ||
    value.includes("/T/nab-workspace-") ||
    value.includes("/T/repro-ws-")
  );
}

function looksLikeFixtureSessionId(sessionId: string): boolean {
  return sessionId === "session-from-client" || sessionId === "session-1";
}

function looksLikeFixturePrompt(initialPrompt: string | undefined): boolean {
  if (!hasText(initialPrompt)) {
    return false;
  }

  const prompt = initialPrompt.trim();
  return FIXTURE_PROMPTS.has(prompt) || FIXTURE_PROMPT_PREFIXES.some((prefix) => prompt.startsWith(prefix));
}

function readPartialSessionMetadata(sessionJsonPath: string): {
  cwd?: string;
  initialPrompt?: string;
  updatedAt?: string;
  createdAt?: string;
} | undefined {
  if (!existsSync(sessionJsonPath)) {
    return undefined;
  }

  try {
    const raw = JSON.parse(readFileSync(sessionJsonPath, "utf8")) as Record<string, unknown>;
    return {
      cwd: asNonEmptyString(raw.cwd),
      initialPrompt: asNonEmptyString(raw.initialPrompt),
      updatedAt: asNonEmptyString(raw.updatedAt),
      createdAt: asNonEmptyString(raw.createdAt),
    };
  } catch {
    return undefined;
  }
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
