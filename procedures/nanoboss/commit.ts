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
      const { refresh, commitContext } = parseCommitPrompt(prompt);
      const checks = expectData(
        await ctx.callProcedure<PreCommitChecksResult>(
          preCommitChecksProcedureName,
          refresh ? "--refresh" : "",
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

      const result = await ctx.callAgent(buildCommitPrompt(ctx.cwd, commitContext), { stream: false });
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

export function parseCommitPrompt(prompt: string): { refresh: boolean; commitContext: string } {
  const refresh = prompt.trim().split(/\s+/).includes("--refresh");
  const commitContext = prompt
    .replace(/(^|\s)--refresh(?=\s|$)/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return {
    refresh,
    commitContext,
  };
}

function buildCommitPrompt(cwd: string, commitContext: string): string {
  return [
    `Git commit the staged or recent changes in ${cwd} with a descriptive message.`,
    "Pre-commit checks have already passed for the current workspace state.",
    "Do not rerun tests, lint, or other validation commands.",
    commitContext.length > 0 ? `Context: ${commitContext}` : undefined,
  ].filter((value): value is string => Boolean(value)).join(" ");
}

export default createNanobossCommitProcedure();
