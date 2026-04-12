import { normalizeProcedureResult } from "../session/index.ts";
import type { SessionStore } from "../session/index.ts";
import { formatErrorMessage } from "./error-format.ts";
import type { RunLogger } from "./logger.ts";
import type { ContextSessionApiImpl, ProcedureInvocationBinding } from "./context-session.ts";
import type {
  ProcedureApi,
  CommandCallProcedureOptions,
  KernelValue,
  ProcedureInvocationApi,
  ProcedureRegistryLike,
  RunResult,
} from "./types.ts";

type ActiveCell = ReturnType<SessionStore["startCell"]>;

export interface ChildContextBindingParams extends ProcedureInvocationBinding {
  procedureName: string;
  spanId: string;
  cell: ActiveCell;
}

interface ProcedureInvocationApiImplParams {
  logger: RunLogger;
  registry: ProcedureRegistryLike;
  store: SessionStore;
  sessionManager: ContextSessionApiImpl;
  assertCanStartBoundary: () => void;
  spanId: string;
  cell: ActiveCell;
  createChildContext: (params: ChildContextBindingParams) => ProcedureApi;
}

export class ProcedureInvocationApiImpl implements ProcedureInvocationApi {
  constructor(private readonly params: ProcedureInvocationApiImplParams) {}

  async run<T extends KernelValue = KernelValue>(
    name: string,
    prompt: string,
    options?: CommandCallProcedureOptions,
  ): Promise<RunResult<T>> {
    const procedure = this.params.registry.get(name);
    if (!procedure) {
      throw new Error(`Unknown procedure: ${name}`);
    }

    const childSpanId = this.params.logger.newSpan(this.params.spanId);
    const startedAt = Date.now();
    this.params.assertCanStartBoundary();
    const childCell = this.params.store.startCell({
      procedure: name,
      input: prompt,
      kind: "procedure",
      parentCellId: this.params.cell.cell.cellId,
    });

    this.params.logger.write({
      spanId: childSpanId,
      parentSpanId: this.params.spanId,
      procedure: name,
      kind: "procedure_start",
      prompt,
    });

    try {
      const binding = this.params.sessionManager.resolveProcedureInvocationBinding(options?.session ?? "inherit");
      const childContext = this.params.createChildContext({
        procedureName: name,
        spanId: childSpanId,
        cell: childCell,
        ...binding,
      });
      const rawResult = await procedure.execute(prompt, childContext);
      const result = normalizeProcedureResult(rawResult);
      const finalized = this.params.store.finalizeCell(childCell, result);

      this.params.logger.write({
        spanId: childSpanId,
        parentSpanId: this.params.spanId,
        procedure: name,
        kind: "procedure_end",
        durationMs: Date.now() - startedAt,
        result: result.data,
        raw: result.display,
      });

      return finalized as RunResult<T>;
    } catch (error) {
      this.params.logger.write({
        spanId: childSpanId,
        parentSpanId: this.params.spanId,
        procedure: name,
        kind: "procedure_end",
        durationMs: Date.now() - startedAt,
        error: formatErrorMessage(error),
      });
      throw error;
    }
  }
}
