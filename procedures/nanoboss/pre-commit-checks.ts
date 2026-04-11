import type { Procedure } from "../../src/core/types.ts";
import type { ResolvedPreCommitChecksResult } from "./test-cache-lib.ts";
import { ensureTrailingNewline, resolvePreCommitChecks } from "./test-cache-lib.ts";
import {
  buildAutomaticFixFailedPreCommitResult,
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
      const options = parsePreCommitChecksPrompt(prompt);
      const result = await runChecksAndPrintOutput({
        resolveChecks,
        ctx,
        refresh: options.refresh,
        verbose: options.verbose,
      });
      if (result.passed) {
        return buildCompletedPreCommitResult(result);
      }

      if (options.manualApprove) {
        return buildPausedFailurePreCommitResult(result, 0);
      }

      ctx.ui.text("Pre-commit checks failed; auto-approving one automated fix pass...\n");
      return await runAutomatedFixPass({
        resolveChecks,
        ctx,
        latestResult: result,
        userReply: "auto-approved by default",
        attemptCount: 0,
        manualApprove: false,
      });
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

      return await runAutomatedFixPass({
        resolveChecks,
        ctx,
        latestResult: state.latestResult,
        userReply: prompt,
        attemptCount: state.attemptCount,
        manualApprove: true,
      });
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
      params.ctx.ui.text(renderPreCommitFreshRunHeader(event.reason, event.command));
    },
    onOutputChunk(chunk) {
      const printable = outputStreamer.consume(chunk);
      if (printable.length > 0) {
        params.ctx.ui.text(printable);
      }
    },
  });

  const trailingOutput = outputStreamer.flush();
  if (trailingOutput.length > 0) {
    params.ctx.ui.text(trailingOutput);
  }

  printPreCommitRunOutput((text) => {
    params.ctx.ui.text(text);
  }, result, {
    refresh: params.refresh,
    verbose: params.verbose,
  });
  return result;
}

function hasFlag(prompt: string, flag: string): boolean {
  return prompt.trim().split(/\s+/).includes(flag);
}

function parsePreCommitChecksPrompt(prompt: string): {
  refresh: boolean;
  verbose: boolean;
  manualApprove: boolean;
} {
  return {
    refresh: hasFlag(prompt, "--refresh"),
    verbose: hasFlag(prompt, "--verbose"),
    manualApprove: hasPromptFlag(prompt, "manual-approve"),
  };
}

function hasPromptFlag(prompt: string, flag: string): boolean {
  return prompt.trim().split(/\s+/).some((token) => token === flag || token === `--${flag}`);
}

async function runAutomatedFixPass(params: {
  resolveChecks: typeof resolvePreCommitChecks;
  ctx: Parameters<Procedure["execute"]>[1];
  latestResult: ResolvedPreCommitChecksResult;
  userReply: string;
  attemptCount: number;
  manualApprove: boolean;
}) {
  params.ctx.ui.text("Attempting one automated fix pass...\n");
  const fixResult = await params.ctx.agent.run(
    buildPreCommitFixPrompt(params.ctx.cwd, params.latestResult, params.userReply),
    { stream: false },
  );
  if (typeof fixResult.data === "string" && fixResult.data.trim().length > 0) {
    params.ctx.ui.text(ensureTrailingNewline(fixResult.data));
  }

  params.ctx.ui.text("Re-running pre-commit checks...\n");
  const rerun = await runChecksAndPrintOutput({
    resolveChecks: params.resolveChecks,
    ctx: params.ctx,
    refresh: true,
    verbose: false,
  });
  if (rerun.passed) {
    return buildCompletedPreCommitResult(rerun);
  }

  return params.manualApprove
    ? buildPausedFailurePreCommitResult(rerun, params.attemptCount + 1)
    : buildAutomaticFixFailedPreCommitResult(rerun, params.attemptCount + 1);
}

export default createPreCommitChecksProcedure();
