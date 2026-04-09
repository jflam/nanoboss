import type { KernelValue, ProcedureResult } from "../../src/core/types.ts";
import {
  renderPreCommitDisplay,
  renderPreCommitFailureDigest,
  renderPreCommitSummary,
} from "./pre-commit-checks-output.ts";
import type { PreCommitChecksResult, ResolvedPreCommitChecksResult } from "./test-cache-lib.ts";

export interface PreCommitChecksPauseState {
  version: 1;
  attemptCount: number;
  latestResult: ResolvedPreCommitChecksResult;
}

const FIX_SUGGESTED_REPLIES = [
  "yes, fix them",
  "no, leave them",
];

export function buildCompletedPreCommitResult(
  result: ResolvedPreCommitChecksResult,
): ProcedureResult<PreCommitChecksResult> {
  return {
    data: serializeChecksResult(result),
    display: renderPreCommitDisplay(result),
    summary: renderPreCommitSummary(result),
  };
}

export function buildPausedFailurePreCommitResult(
  result: ResolvedPreCommitChecksResult,
  attemptCount: number,
): ProcedureResult<PreCommitChecksResult> {
  const question = buildFixQuestion(result, attemptCount);
  const attemptLine = attemptCount > 0
    ? `Automatic fix attempt ${attemptCount} did not clear all issues.`
    : undefined;

  return {
    data: serializeChecksResult(result),
    display: [
      renderPreCommitDisplay(result).trimEnd(),
      renderPreCommitFailureDigest(result),
      attemptLine,
      question,
    ].filter((value): value is string => Boolean(value)).join("\n") + "\n",
    summary: renderPreCommitSummary(result),
    pause: {
      question,
      state: {
        version: 1,
        attemptCount,
        latestResult: result,
      },
      inputHint: "Reply yes to attempt an automated fix pass, or no to leave the failures as-is",
      suggestedReplies: FIX_SUGGESTED_REPLIES,
    },
  };
}

export function buildClarifyingPreCommitPauseResult(
  state: PreCommitChecksPauseState,
): ProcedureResult<PreCommitChecksResult> {
  const question = "Reply yes to attempt an automated fix pass, or no to leave the current failures as-is.";
  return {
    data: serializeChecksResult(state.latestResult),
    display: `${question}\n`,
    summary: renderPreCommitSummary(state.latestResult),
    pause: {
      question,
      state,
      inputHint: "Reply yes or no",
      suggestedReplies: FIX_SUGGESTED_REPLIES,
    },
  };
}

export function buildDeclinedPreCommitResult(
  result: ResolvedPreCommitChecksResult,
): ProcedureResult<PreCommitChecksResult> {
  return {
    data: serializeChecksResult(result),
    display: "Pre-commit checks still fail. Automatic fix was skipped.\n",
    summary: renderPreCommitSummary(result),
  };
}

export function buildPreCommitFixPrompt(
  cwd: string,
  result: ResolvedPreCommitChecksResult,
  userReply: string,
): string {
  return [
    `Inspect the repository at ${cwd} and fix the current pre-commit check failures.`,
    "You are handling one bounded automatic fix pass for the caller.",
    `The failing validation command is: ${result.command}`,
    `The most recent exit code was: ${result.exitCode}`,
    `The user reply was: ${userReply.trim() || "(empty reply)"}`,
    "Fix the underlying issues directly in the repository.",
    "Do not create commits.",
    "Do not run the full validation command again after your edits; the caller will rerun it.",
    "Keep the changes narrowly focused on the reported failures.",
    "",
    "Validation output:",
    result.combinedOutput,
  ].join("\n");
}

export function parsePreCommitFixDecision(prompt: string): "accept" | "decline" | "unclear" {
  const normalized = prompt.trim().toLowerCase();
  if (!normalized) {
    return "unclear";
  }

  if (
    normalized.includes("yes")
    || normalized.includes("fix")
    || normalized.includes("try")
    || normalized.includes("go ahead")
    || normalized.includes("do it")
  ) {
    return "accept";
  }

  if (
    normalized.includes("no")
    || normalized.includes("skip")
    || normalized.includes("leave")
    || normalized.includes("stop")
    || normalized.includes("don't")
    || normalized.includes("do not")
  ) {
    return "decline";
  }

  return "unclear";
}

export function requirePreCommitPauseState(stateValue: KernelValue): PreCommitChecksPauseState {
  if (!isPreCommitChecksPauseState(stateValue)) {
    throw new Error("Invalid pre-commit checks continuation state");
  }
  return stateValue;
}

function buildFixQuestion(result: ResolvedPreCommitChecksResult, attemptCount: number): string {
  return attemptCount > 0
    ? `Pre-commit checks still fail with exit ${result.exitCode}. Do you want me to try another automated fix pass?`
    : `Pre-commit checks failed with exit ${result.exitCode}. Do you want me to try fixing these automatically?`;
}

function serializeChecksResult(result: ResolvedPreCommitChecksResult): PreCommitChecksResult {
  return {
    command: result.command,
    cacheHit: result.cacheHit,
    exitCode: result.exitCode,
    passed: result.passed,
    workspaceStateFingerprint: result.workspaceStateFingerprint,
    runtimeFingerprint: result.runtimeFingerprint,
    createdAt: result.createdAt,
  };
}

function isPreCommitChecksPauseState(value: KernelValue): value is PreCommitChecksPauseState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return candidate.version === 1
    && typeof candidate.attemptCount === "number"
    && isResolvedPreCommitChecksResult(candidate.latestResult);
}

function isResolvedPreCommitChecksResult(value: unknown): value is ResolvedPreCommitChecksResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return typeof candidate.command === "string"
    && typeof candidate.cacheHit === "boolean"
    && typeof candidate.runReason === "string"
    && typeof candidate.exitCode === "number"
    && typeof candidate.passed === "boolean"
    && typeof candidate.workspaceStateFingerprint === "string"
    && typeof candidate.runtimeFingerprint === "string"
    && typeof candidate.createdAt === "string"
    && typeof candidate.stdout === "string"
    && typeof candidate.stderr === "string"
    && typeof candidate.combinedOutput === "string"
    && typeof candidate.summary === "string"
    && typeof candidate.durationMs === "number";
}
