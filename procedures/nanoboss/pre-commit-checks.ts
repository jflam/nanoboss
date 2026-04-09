import type { Procedure } from "../../src/core/types.ts";

import {
  ensureTrailingNewline,
  resolvePreCommitChecks,
  type PreCommitChecksFreshRunReason,
  type ResolvedPreCommitChecksResult,
} from "./test-cache-lib.ts";

interface PreCommitChecksProcedureDeps {
  resolveChecks?: typeof resolvePreCommitChecks;
}

export function createPreCommitChecksProcedure(
  deps: PreCommitChecksProcedureDeps = {},
): Procedure {
  const resolveChecks = deps.resolveChecks ?? resolvePreCommitChecks;

  return {
    name: "nanoboss/pre-commit-checks",
    description: "Run or replay the repo pre-commit validation command",
    async execute(prompt, ctx) {
      const refresh = hasRefreshFlag(prompt);
      let streamedFreshOutputLength = 0;
      const result = await resolveChecks({
        cwd: ctx.cwd,
        refresh,
        onFreshRun(event) {
          ctx.print(renderFreshRunHeader(event.reason, event.command));
        },
        onOutputChunk(chunk) {
          streamedFreshOutputLength += chunk.length;
          ctx.print(chunk);
        },
      });

      if (result.cacheHit) {
        ctx.print(renderHeader(result, refresh));
        ctx.print(ensureTrailingNewline(result.combinedOutput));
      } else {
        const remainingFreshOutput = result.combinedOutput.slice(streamedFreshOutputLength);
        if (remainingFreshOutput.length > 0) {
          ctx.print(ensureTrailingNewline(remainingFreshOutput));
        }
      }

      return {
        data: {
          command: result.command,
          cacheHit: result.cacheHit,
          exitCode: result.exitCode,
          passed: result.passed,
          workspaceStateFingerprint: result.workspaceStateFingerprint,
          runtimeFingerprint: result.runtimeFingerprint,
          createdAt: result.createdAt,
        },
        display: renderDisplay(result),
        summary: renderSummary(result),
      };
    },
  };
}

function hasRefreshFlag(prompt: string): boolean {
  return prompt.trim().split(/\s+/).includes("--refresh");
}

function renderHeader(result: ResolvedPreCommitChecksResult, refresh: boolean): string {
  if (result.cacheHit) {
    return `Pre-commit checks cache hit for \`${result.command}\`.\n`;
  }

  if (refresh) {
    return `Refreshing pre-commit checks with \`${result.command}\`.\n`;
  }

  return `Running pre-commit checks with \`${result.command}\`.\n`;
}

function renderFreshRunHeader(reason: PreCommitChecksFreshRunReason, command: string): string {
  switch (reason) {
    case "refresh":
      return `Refresh requested; re-running pre-commit checks with \`${command}\`.\n`;
    case "cold_cache":
      return `No cached pre-commit result matched; running \`${command}\`.\n`;
    case "workspace_changed":
      return `Dirty repo detected; re-running tests for confidence with \`${command}\`.\n`;
    case "runtime_changed":
      return `Runtime changed since the last cached result; re-running \`${command}\`.\n`;
    case "command_changed":
      return `Pre-commit command changed; re-running \`${command}\`.\n`;
  }
}

function renderDisplay(result: ResolvedPreCommitChecksResult): string {
  const source = result.cacheHit ? "cached" : "fresh";
  const status = result.passed ? "passed" : `failed (exit ${result.exitCode})`;
  return `Pre-commit checks ${status} using ${source} result for \`${result.command}\`.\n`;
}

function renderSummary(result: ResolvedPreCommitChecksResult): string {
  const status = result.passed ? "pass" : `fail (${result.exitCode})`;
  return `nanoboss/pre-commit-checks: ${status}${result.cacheHit ? " cached" : ""}`;
}

export default createPreCommitChecksProcedure();
