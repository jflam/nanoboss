import { normalizeAgentTokenUsage } from "../agent/token-usage.ts";
import type { DefaultConversationSession } from "../agent/default-session.ts";
import { buildProcedureExecutionResult, type ProcedureExecutionResult } from "./runner.ts";
import { createValueRef, type SessionStore } from "../session/index.ts";
import { inferDataShape } from "../core/data-shape.ts";
import type { AgentTokenUsage, CellRecord, DownstreamAgentConfig, ValueRef } from "../core/types.ts";
import { summarizeText } from "../util/text.ts";

export function isProcedureDispatchTimeout(message: string | undefined): boolean {
  return Boolean(message && /request timed out/i.test(message));
}

export async function waitForRecoveredProcedureDispatchCell(
  store: SessionStore,
  params: {
    procedureName: string;
    dispatchCorrelationId: string;
  },
): Promise<CellRecord | undefined> {
  const deadline = Date.now() + getProcedureDispatchRecoveryWaitMs();

  for (;;) {
    const found = findRecoveredProcedureDispatchCell(store, params);
    if (found) {
      return found;
    }

    if (Date.now() >= deadline) {
      return undefined;
    }

    await Bun.sleep(1_000);
  }
}

export function findRecoveredProcedureDispatchCell(
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
  cell: CellRecord;
  signal?: AbortSignal;
  defaultAgentConfig: DownstreamAgentConfig;
}): Promise<AgentTokenUsage | undefined> {
  await params.defaultConversation.prompt(
    buildRecoveredProcedureSyncPrompt(params.sessionId, params.cell),
    {
      signal: params.signal,
    },
  );

  return normalizeAgentTokenUsage(
    await params.defaultConversation.getCurrentTokenSnapshot(),
    params.defaultAgentConfig,
  );
}

export function procedureDispatchResultFromRecoveredCell(sessionId: string, cell: CellRecord): ProcedureExecutionResult {
  return buildProcedureExecutionResult({ sessionId, cell });
}

export function buildRecoveredProcedureSyncPrompt(sessionId: string, cell: CellRecord): string {
  const cellRef = { sessionId, cellId: cell.cellId };
  const dataRef = cell.output.data !== undefined ? createValueRef(cellRef, "output.data") : undefined;
  const displayRef = cell.output.display !== undefined ? createValueRef(cellRef, "output.display") : undefined;
  const dataShape = cell.output.data !== undefined ? inferDataShape(cell.output.data) : undefined;

  return [
    "Nanoboss internal recovered procedure synchronization.",
    "A slash command finished durably after the outer async dispatch MCP polling path failed to deliver the terminal result.",
    "Treat the following as the authoritative stored result for future turns in this same persistent master conversation.",
    "Do not answer the user. Respond with exactly: OK",
    "",
    `Procedure: /${cell.procedure}`,
    cell.input.trim() ? `Original input: ${summarizeText(cell.input, 500)}` : undefined,
    cell.output.summary ? `Summary: ${summarizeText(cell.output.summary, 800)}` : undefined,
    cell.output.memory ? `Memory: ${summarizeText(cell.output.memory, 800)}` : undefined,
    !cell.output.summary && !cell.output.memory && cell.output.display
      ? `Display preview: ${summarizeText(cell.output.display, 1200)}`
      : undefined,
    `Cell: session=${sessionId} cell=${cell.cellId}`,
    dataRef ? `Data ref: ${formatValueRef(dataRef)}` : undefined,
    displayRef ? `Display ref: ${formatValueRef(displayRef)}` : undefined,
    dataShape !== undefined ? `Data shape: ${JSON.stringify(dataShape)}` : undefined,
    cell.output.explicitDataSchema
      ? `Explicit data schema: ${summarizeText(JSON.stringify(cell.output.explicitDataSchema), 800)}`
      : undefined,
    "",
    "Use the attached nanoboss session MCP tools later if you need exact stored values.",
  ].filter((line): line is string => Boolean(line)).join("\n");
}

function getProcedureDispatchRecoveryWaitMs(): number {
  const value = Number(process.env.NANOBOSS_PROCEDURE_DISPATCH_RECOVERY_WAIT_MS ?? "30000");
  return Number.isFinite(value) && value > 0 ? value : 30000;
}

function formatValueRef(valueRef: ValueRef): string {
  return [
    `session=${valueRef.cell.sessionId}`,
    `cell=${valueRef.cell.cellId}`,
    `path=${valueRef.path}`,
  ].join(" ");
}
