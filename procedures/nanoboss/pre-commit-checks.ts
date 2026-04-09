import type { Procedure } from "../../src/core/types.ts";

import {
  ensureTrailingNewline,
  resolvePreCommitChecks,
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
      const result = resolveChecks({
        cwd: ctx.cwd,
        refresh,
      });

      ctx.print(renderHeader(result, refresh));
      if (result.combinedOutput.length > 0) {
        ctx.print(ensureTrailingNewline(result.combinedOutput));
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
