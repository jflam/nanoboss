import { expectData } from "../../src/core/run-result.ts";
import type { Procedure } from "../../src/core/types.ts";

import type { PreCommitChecksResult } from "./test-cache-lib.ts";

interface NanobossCommitProcedureDeps {
  preCommitChecksProcedureName?: string;
}

export function createNanobossCommitProcedure(
  deps: NanobossCommitProcedureDeps = {},
): Procedure {
  const preCommitChecksProcedureName = deps.preCommitChecksProcedureName ?? "nanoboss/pre-commit-checks";

  return {
    name: "nanoboss/commit",
    description: "Run repo pre-commit checks, then create a descriptive git commit",
    async execute(prompt, ctx) {
      const { refresh, manualApprove, commitContext } = parseCommitPrompt(prompt);
      const checks = expectData(
        await ctx.procedures.run<PreCommitChecksResult>(
          preCommitChecksProcedureName,
          [refresh ? "--refresh" : undefined, manualApprove ? "manual-approve" : undefined]
            .filter((value): value is string => Boolean(value))
            .join(" "),
        ),
        "Missing pre-commit checks result",
      );

      if (!checks.passed) {
        return {
          data: {
            checks,
          },
          display: "Pre-commit checks failed. Commit was not created.\n",
          summary: "nanoboss/commit: blocked by failing pre-commit checks",
        };
      }

      const result = await ctx.agent.run(buildCommitPrompt(ctx.cwd, commitContext), { stream: false });
      if (!result.dataRef) {
        throw new Error("Missing commit data ref");
      }

      return {
        data: {
          checks,
          commit: result.dataRef,
        },
        display: result.data,
        summary: commitContext ? `nanoboss/commit: ${commitContext}` : "nanoboss/commit",
      };
    },
  };
}

export function parseCommitPrompt(
  prompt: string,
): { refresh: boolean; manualApprove: boolean; commitContext: string } {
  const refresh = prompt.trim().split(/\s+/).includes("--refresh");
  const manualApprove = prompt.trim().split(/\s+/).some((token) =>
    token === "manual-approve" || token === "--manual-approve"
  );
  const commitContext = prompt
    .replace(/(^|\s)--refresh(?=\s|$)/g, " ")
    .replace(/(^|\s)(?:--)?manual-approve(?=\s|$)/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return {
    refresh,
    manualApprove,
    commitContext,
  };
}

function buildCommitPrompt(cwd: string, commitContext: string): string {
  return [
    `Create one git commit for the current workspace in ${cwd}.`,
    "Pre-commit checks have already passed for the current workspace state.",
    "Do not rerun tests, lint, or other validation commands.",
    commitContext.length > 0
      ? `User-provided commit intent: ${commitContext}. Treat this as the primary description of the intended work. If it references a repo file or plan, read that file first and avoid unrelated exploration.`
      : undefined,
    "Prefer a concise single-line commit message under 72 characters.",
    "Do not narrate your reasoning or progress. Return only the commit sha, message, and whether the tree is clean.",
  ].filter((value): value is string => Boolean(value)).join(" ");
}

export default createNanobossCommitProcedure();
