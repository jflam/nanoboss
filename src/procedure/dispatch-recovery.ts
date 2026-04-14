import { normalizeAgentTokenUsage } from "../agent/token-usage.ts";
import {
  RunCancelledError,
  defaultCancellationMessage,
} from "../core/cancellation.ts";
import { createTextPromptInput } from "../core/prompt.ts";
import type { DefaultConversationSession } from "../agent/default-session.ts";
import { buildProcedureExecutionResult, type ProcedureExecutionResult } from "./runner.ts";
import type { SessionStore } from "../session/index.ts";
import { inferDataShape } from "../core/data-shape.ts";
import type { AgentTokenUsage, DownstreamAgentConfig, Ref } from "../core/types.ts";
import { createRef } from "../core/types.ts";
import type { CellRecord } from "../session/store-records.ts";
import { summarizeText } from "../util/text.ts";

export function isProcedureDispatchTimeout(message: string | undefined): boolean {
  return Boolean(message && /request timed out/i.test(message));
}

export async function waitForRecoveredProcedureDispatchRecord(
  store: SessionStore,
  params: {
    procedureName: string;
    dispatchCorrelationId: string;
    signal?: AbortSignal;
    softStopSignal?: AbortSignal;
  },
): Promise<CellRecord | undefined> {
  const deadline = Date.now() + getProcedureDispatchRecoveryWaitMs();

  for (;;) {
    if (params.softStopSignal?.aborted) {
      throw new RunCancelledError(defaultCancellationMessage("soft_stop"), "soft_stop");
    }

    if (params.signal?.aborted) {
      throw new RunCancelledError(defaultCancellationMessage("abort"), "abort");
    }

    const found = findRecoveredProcedureDispatchRecord(store, params);
    if (found) {
      return found;
    }

    if (Date.now() >= deadline) {
      return undefined;
    }

    await Bun.sleep(1_000);
  }
}

export function findRecoveredProcedureDispatchRecord(
  store: SessionStore,
  params: {
    procedureName: string;
    dispatchCorrelationId: string;
  },
): CellRecord | undefined {
  const summaries = store.topLevelRuns({ procedure: params.procedureName, limit: 50 });
  for (const summary of summaries) {
    const cell = store.readCell(summary.cell);
    if (cell.meta.dispatchCorrelationId === params.dispatchCorrelationId) {
      return cell;
    }
  }

  return undefined;
}

export async function syncRecoveredProcedureResultIntoDefaultConversation(params: {
  defaultConversation: DefaultConversationSession;
  sessionId: string;
  record: CellRecord;
  signal?: AbortSignal;
  defaultAgentConfig: DownstreamAgentConfig;
}): Promise<AgentTokenUsage | undefined> {
  await params.defaultConversation.prompt(
    createTextPromptInput(buildRecoveredProcedureSyncPrompt(params.sessionId, params.record)),
    {
      signal: params.signal,
    },
  );

  return normalizeAgentTokenUsage(
    await params.defaultConversation.getCurrentTokenSnapshot(),
    params.defaultAgentConfig,
  );
}

export function procedureDispatchResultFromRecoveredRecord(sessionId: string, record: CellRecord): ProcedureExecutionResult {
  return buildProcedureExecutionResult({ sessionId, cell: record });
}

export function buildRecoveredProcedureSyncPrompt(sessionId: string, record: CellRecord): string {
  const run = { sessionId, runId: record.cellId };
  const dataRef = record.output.data !== undefined
    ? createRef(run, "output.data")
    : undefined;
  const displayRef = record.output.display !== undefined
    ? createRef(run, "output.display")
    : undefined;
  const dataShape = record.output.data !== undefined ? inferDataShape(record.output.data) : undefined;

  return [
    "Nanoboss internal recovered procedure synchronization.",
    "A slash command finished durably after the outer async dispatch MCP polling path failed to deliver the terminal result.",
    "Treat the following as the authoritative stored result for future turns in this same persistent master conversation.",
    "Do not answer the user. Respond with exactly: OK",
    "",
    `Procedure: /${record.procedure}`,
    record.input.trim() ? `Original input: ${summarizeText(record.input, 500)}` : undefined,
    record.output.summary ? `Summary: ${summarizeText(record.output.summary, 800)}` : undefined,
    record.output.memory ? `Memory: ${summarizeText(record.output.memory, 800)}` : undefined,
    !record.output.summary && !record.output.memory && record.output.display
      ? `Display preview: ${summarizeText(record.output.display, 1200)}`
      : undefined,
    `Run: session=${run.sessionId} run=${run.runId}`,
    dataRef ? `Data ref: ${formatRef(dataRef)}` : undefined,
    displayRef ? `Display ref: ${formatRef(displayRef)}` : undefined,
    dataShape !== undefined ? `Data shape: ${JSON.stringify(dataShape)}` : undefined,
    record.output.explicitDataSchema
      ? `Explicit data schema: ${summarizeText(JSON.stringify(record.output.explicitDataSchema), 800)}`
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
