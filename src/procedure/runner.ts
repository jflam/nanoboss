import { CommandContextImpl, type SessionUpdateEmitter } from "../core/context.ts";
import type { DefaultConversationSession } from "../agent/default-session.ts";
import type { FrontendEvent } from "../http/frontend-events.ts";
import { RunLogger } from "../core/logger.ts";
import { inferDataShape } from "../core/data-shape.ts";
import {
  SessionStore,
  createValueRef,
  normalizeProcedureResult,
} from "../session/index.ts";
import { toDownstreamAgentSelection } from "../core/config.ts";
import { summarizeText } from "../util/text.ts";
import type {
  AgentTokenUsage,
  CellRecord,
  CellRef,
  DownstreamAgentConfig,
  DownstreamAgentSelection,
  Procedure,
  ProcedureRegistryLike,
  ValueRef,
} from "../core/types.ts";

interface PreparedDefaultPrompt {
  prompt: string;
  markSubmitted?: () => void;
}

export interface ProcedureExecutionResult {
  procedure: string;
  cell: CellRef;
  summary?: string;
  display?: string;
  memory?: string;
  dataRef?: ValueRef;
  displayRef?: ValueRef;
  streamRef?: ValueRef;
  dataShape?: unknown;
  explicitDataSchema?: object;
  tokenUsage?: AgentTokenUsage;
  defaultAgentSelection?: DownstreamAgentSelection;
}

export interface ProcedureRunnerEmitter extends SessionUpdateEmitter {
  readonly currentTokenUsage?: AgentTokenUsage;
}

export class TopLevelProcedureExecutionError extends Error {
  constructor(message: string, readonly cell: CellRef) {
    super(message);
    this.name = "TopLevelProcedureExecutionError";
  }
}

export async function executeTopLevelProcedure(params: {
  cwd: string;
  sessionId: string;
  store: SessionStore;
  registry: ProcedureRegistryLike;
  procedure: Procedure;
  prompt: string;
  emitter: ProcedureRunnerEmitter;
  signal?: AbortSignal;
  defaultConversation?: DefaultConversationSession;
  getDefaultAgentConfig: () => DownstreamAgentConfig;
  setDefaultAgentSelection: (selection: DownstreamAgentSelection) => DownstreamAgentConfig;
  prepareDefaultPrompt?: (prompt: string) => PreparedDefaultPrompt;
  onError?: (ctx: CommandContextImpl, errorText: string) => void | Promise<void>;
  dispatchCorrelationId?: string;
}): Promise<ProcedureExecutionResult> {
  const logger = new RunLogger();
  const rootSpanId = logger.newSpan();
  const rootCell = params.store.startCell({
    procedure: params.procedure.name,
    input: params.prompt,
    kind: "top_level",
    dispatchCorrelationId: params.dispatchCorrelationId,
  });
  const beforeSelection = toDownstreamAgentSelection(params.getDefaultAgentConfig());
  const startedAt = Date.now();

  const ctx = new CommandContextImpl({
    cwd: params.cwd,
    sessionId: params.sessionId,
    logger,
    registry: params.registry,
    procedureName: params.procedure.name,
    spanId: rootSpanId,
    emitter: params.emitter,
    store: params.store,
    cell: rootCell,
    signal: params.signal,
    defaultConversation: params.defaultConversation,
    getDefaultAgentConfig: params.getDefaultAgentConfig,
    setDefaultAgentSelection: params.setDefaultAgentSelection,
    prepareDefaultPrompt: params.prepareDefaultPrompt,
  });

  logger.write({
    spanId: rootSpanId,
    procedure: params.procedure.name,
    kind: "procedure_start",
    prompt: params.prompt,
  });

  try {
    const rawResult = await params.procedure.execute(params.prompt, ctx);
    const result = normalizeProcedureResult(rawResult);
    const afterSelection = toDownstreamAgentSelection(params.getDefaultAgentConfig());
    const changedSelection = sameSelection(beforeSelection, afterSelection) ? undefined : afterSelection;
    const finalized = params.store.finalizeCell(rootCell, result, {
      meta: changedSelection ? { defaultAgentSelection: changedSelection } : undefined,
    });
    const record = params.store.readCell(finalized.cell);

    logger.write({
      spanId: rootSpanId,
      procedure: params.procedure.name,
      kind: "procedure_end",
      durationMs: Date.now() - startedAt,
      result: result.data,
      raw: result.display,
    });

    return buildProcedureExecutionResult({
      sessionId: params.sessionId,
      cell: record,
      tokenUsage: params.emitter.currentTokenUsage,
      defaultAgentSelection: changedSelection,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const errorText = `Error: ${message}\n`;

    logger.write({
      spanId: rootSpanId,
      procedure: params.procedure.name,
      kind: "procedure_end",
      durationMs: Date.now() - startedAt,
      error: message,
    });

    await params.onError?.(ctx, errorText);
    const finalized = params.store.finalizeCell(rootCell, {
      summary: summarizeText(errorText),
    });
    throw new TopLevelProcedureExecutionError(message, finalized.cell);
  } finally {
    await params.emitter.flush();
    logger.close();
  }
}

export function buildProcedureExecutionResult(params: {
  sessionId: string;
  cell: CellRecord;
  tokenUsage?: AgentTokenUsage;
  defaultAgentSelection?: DownstreamAgentSelection;
}): ProcedureExecutionResult {
  const cellRef = { sessionId: params.sessionId, cellId: params.cell.cellId };
  return {
    procedure: params.cell.procedure,
    cell: cellRef,
    summary: params.cell.output.summary,
    display: params.cell.output.display,
    memory: params.cell.output.memory,
    dataRef: params.cell.output.data !== undefined ? createValueRef(cellRef, "output.data") : undefined,
    displayRef: params.cell.output.display !== undefined ? createValueRef(cellRef, "output.display") : undefined,
    streamRef: params.cell.output.stream !== undefined ? createValueRef(cellRef, "output.stream") : undefined,
    dataShape: params.cell.output.data !== undefined ? inferDataShape(params.cell.output.data) : undefined,
    explicitDataSchema: params.cell.output.explicitDataSchema,
    tokenUsage: params.tokenUsage,
    defaultAgentSelection: params.defaultAgentSelection ?? params.cell.meta.defaultAgentSelection,
  };
}

export function buildRunCompletedEvent(params: {
  runId: string;
  procedure: string;
  result: Pick<ProcedureExecutionResult, "cell" | "summary" | "display">;
  completedAt?: string;
  tokenUsage?: AgentTokenUsage;
}): Extract<FrontendEvent, { type: "run_completed" }> {
  return {
    type: "run_completed",
    runId: params.runId,
    procedure: params.procedure,
    completedAt: params.completedAt ?? new Date().toISOString(),
    cell: params.result.cell,
    summary: params.result.summary,
    display: params.result.display,
    tokenUsage: params.tokenUsage,
  };
}

function sameSelection(
  left: DownstreamAgentSelection | undefined,
  right: DownstreamAgentSelection | undefined,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
