import type { Procedure } from "../../src/core/types.ts";
import { ensureTrailingNewline, resolvePreCommitChecks } from "./test-cache-lib.ts";
import {
  buildClarifyingPreCommitPauseResult,
  buildCompletedPreCommitResult,
  buildDeclinedPreCommitResult,
  buildPausedFailurePreCommitResult,
  buildPreCommitFixPrompt,
  parsePreCommitFixDecision,
  requirePreCommitPauseState,
} from "./pre-commit-checks-results.ts";
import {
  createPreCommitOutputStreamer,
  printPreCommitRunOutput,
  renderPreCommitFreshRunHeader,
} from "./pre-commit-checks-output.ts";

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
      const result = await runChecksAndPrintOutput({
        resolveChecks,
        ctx,
        refresh: hasFlag(prompt, "--refresh"),
        verbose: hasFlag(prompt, "--verbose"),
      });
      return result.passed
        ? buildCompletedPreCommitResult(result)
        : buildPausedFailurePreCommitResult(result, 0);
    },
    async resume(prompt, stateValue, ctx) {
      const state = requirePreCommitPauseState(stateValue);
      const decision = parsePreCommitFixDecision(prompt);
      if (decision === "unclear") {
        return buildClarifyingPreCommitPauseResult(state);
      }
      if (decision === "decline") {
        return buildDeclinedPreCommitResult(state.latestResult);
      }

      ctx.print("Attempting one automated fix pass...\n");
      const fixResult = await ctx.callAgent(
        buildPreCommitFixPrompt(ctx.cwd, state.latestResult, prompt),
        { stream: false },
      );
      if (typeof fixResult.data === "string" && fixResult.data.trim().length > 0) {
        ctx.print(ensureTrailingNewline(fixResult.data));
      }

      ctx.print("Re-running pre-commit checks...\n");
      const rerun = await runChecksAndPrintOutput({
        resolveChecks,
        ctx,
        refresh: true,
        verbose: false,
      });
      return rerun.passed
        ? buildCompletedPreCommitResult(rerun)
        : buildPausedFailurePreCommitResult(rerun, state.attemptCount + 1);
    },
  };
}

async function runChecksAndPrintOutput(params: {
  resolveChecks: typeof resolvePreCommitChecks;
  ctx: Parameters<Procedure["execute"]>[1];
  refresh: boolean;
  verbose: boolean;
}) {
  const outputStreamer = createPreCommitOutputStreamer(params.verbose);
  const result = await params.resolveChecks({
    cwd: params.ctx.cwd,
    refresh: params.refresh,
    onFreshRun(event) {
      params.ctx.print(renderPreCommitFreshRunHeader(event.reason, event.command));
    },
    onOutputChunk(chunk) {
      const printable = outputStreamer.consume(chunk);
      if (printable.length > 0) {
        params.ctx.print(printable);
      }
    },
  });

  const trailingOutput = outputStreamer.flush();
  if (trailingOutput.length > 0) {
    params.ctx.print(trailingOutput);
  }

  printPreCommitRunOutput((text) => {
    params.ctx.print(text);
  }, result, {
    refresh: params.refresh,
    verbose: params.verbose,
  });
  return result;
}

function hasFlag(prompt: string, flag: string): boolean {
  return prompt.trim().split(/\s+/).includes(flag);
}

export default createPreCommitChecksProcedure();
