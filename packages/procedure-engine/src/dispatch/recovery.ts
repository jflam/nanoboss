import { normalizeAgentTokenUsage } from "@nanoboss/agent-acp";
import type { SessionStore } from "@nanoboss/store";
import type { AgentSession } from "@nanoboss/contracts";
import { createRef } from "@nanoboss/contracts";
import type { AgentTokenUsage, DownstreamAgentConfig, Ref, RunRecord, RunResult } from "@nanoboss/procedure-sdk";
import { createTextPromptInput } from "@nanoboss/procedure-sdk";

import { RunCancelledError, defaultCancellationMessage } from "../cancellation.ts";
import { inferDataShape } from "../data-shape.ts";
import { runResultFromRunRecord } from "../run-result.ts";
import { summarizeText } from "../text.ts";

export function isProcedureDispatchTimeout(message: string | undefined): boolean {
  return Boolean(message && /request timed out/i.test(message));
}

export async function waitForRecoveredProcedureDispatchRun(
  store: SessionStore,
  params: {
    procedureName: string;
    dispatchCorrelationId: string;
    signal?: AbortSignal;
    softStopSignal?: AbortSignal;
  },
): Promise<RunRecord | undefined> {
  const deadline = Date.now() + getProcedureDispatchRecoveryWaitMs();

  for (;;) {
    if (params.softStopSignal?.aborted) {
      throw new RunCancelledError(defaultCancellationMessage("soft_stop"), "soft_stop");
    }

    if (params.signal?.aborted) {
      throw new RunCancelledError(defaultCancellationMessage("abort"), "abort");
    }

    const found = findRecoveredProcedureDispatchRun(store, params);
    if (found) {
      return found;
    }

    if (Date.now() >= deadline) {
      return undefined;
    }

    await Bun.sleep(1_000);
  }
}

export function findRecoveredProcedureDispatchRun(
  store: SessionStore,
  params: {
    procedureName: string;
    dispatchCorrelationId: string;
  },
): RunRecord | undefined {
  const summaries = store.listRuns({ procedure: params.procedureName, limit: 50 });
  for (const summary of summaries) {
    const run = store.getRun(summary.run);
    if (run.meta.dispatchCorrelationId === params.dispatchCorrelationId) {
      return run;
    }
  }

  return undefined;
}

export async function syncRecoveredProcedureResultIntoDefaultConversation(params: {
  agentSession: AgentSession;
  run: RunRecord;
  signal?: AbortSignal;
  defaultAgentConfig: DownstreamAgentConfig;
}): Promise<AgentTokenUsage | undefined> {
  await params.agentSession.prompt(
    createTextPromptInput(buildRecoveredProcedureSyncPrompt(params.run)),
    {
      signal: params.signal,
    },
  );

  return normalizeAgentTokenUsage(
    await params.agentSession.getCurrentTokenSnapshot(),
    params.defaultAgentConfig,
  );
}

export function procedureDispatchResultFromRecoveredRun(run: RunRecord): RunResult {
  return runResultFromRunRecord(run);
}

export function buildRecoveredProcedureSyncPrompt(run: RunRecord): string {
  const dataRef = run.output.data !== undefined
    ? createRef(run.run, "output.data")
    : undefined;
  const displayRef = run.output.display !== undefined
    ? createRef(run.run, "output.display")
    : undefined;
  const dataShape = run.output.data !== undefined ? inferDataShape(run.output.data) : undefined;

  return [
    "Nanoboss internal recovered procedure synchronization.",
    "A slash command finished durably after the outer async dispatch MCP polling path failed to deliver the terminal result.",
    "Treat the following as the authoritative stored result for future turns in this same persistent master conversation.",
    "Do not answer the user. Respond with exactly: OK",
    "",
    `Procedure: /${run.procedure}`,
    run.input.trim() ? `Original input: ${summarizeText(run.input, 500)}` : undefined,
    run.output.summary ? `Summary: ${summarizeText(run.output.summary, 800)}` : undefined,
    run.output.memory ? `Memory: ${summarizeText(run.output.memory, 800)}` : undefined,
    !run.output.summary && !run.output.memory && run.output.display
      ? `Display preview: ${summarizeText(run.output.display, 1200)}`
      : undefined,
    `Run: session=${run.run.sessionId} run=${run.run.runId}`,
    dataRef ? `Data ref: ${formatRef(dataRef)}` : undefined,
    displayRef ? `Display ref: ${formatRef(displayRef)}` : undefined,
    dataShape !== undefined ? `Data shape: ${JSON.stringify(dataShape)}` : undefined,
    run.output.explicitDataSchema
      ? `Explicit data schema: ${summarizeText(JSON.stringify(run.output.explicitDataSchema), 800)}`
      : undefined,
    "",
    "Use the global nanoboss MCP tools later if you need exact stored values.",
  ].filter((line): line is string => Boolean(line)).join("\n");
}

function getProcedureDispatchRecoveryWaitMs(): number {
  const value = Number(process.env.NANOBOSS_PROCEDURE_DISPATCH_RECOVERY_WAIT_MS ?? "30000");
  return Number.isFinite(value) && value > 0 ? value : 30000;
}

function formatRef(ref: Ref): string {
  return [
    `session=${ref.run.sessionId}`,
    `run=${ref.run.runId}`,
    `path=${ref.path}`,
  ].join(" ");
}
