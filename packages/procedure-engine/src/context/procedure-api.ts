import { normalizeProcedureResult, type SessionStore } from "@nanoboss/store";
import type { ContextSessionApiImpl, ProcedureInvocationBinding } from "./session-api.ts";
import type {
  CommandCallProcedureOptions,
  KernelValue,
  ProcedureApi,
  PromptInput,
  ProcedureInvocationApi,
  ProcedureRegistryLike,
  RunResult,
} from "@nanoboss/procedure-sdk";
import { createTextPromptInput, promptInputDisplayText } from "@nanoboss/procedure-sdk";

import { formatErrorMessage } from "../error-format.ts";
import type { RunLogger } from "../logger.ts";
import { toPublicRunResult } from "../run-result.ts";

type ActiveRun = ReturnType<SessionStore["startRun"]>;

export interface ChildContextBindingParams extends ProcedureInvocationBinding {
  procedureName: string;
  spanId: string;
  run: ActiveRun;
  promptInput: PromptInput;
}

interface ProcedureInvocationApiImplParams {
  logger: RunLogger;
  registry: ProcedureRegistryLike;
  store: SessionStore;
  sessionManager: ContextSessionApiImpl;
  assertCanStartBoundary: () => void;
  spanId: string;
  run: ActiveRun;
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
    const promptInput = createTextPromptInput(prompt);
    const childRun = this.params.store.startRun({
      procedure: name,
      input: promptInputDisplayText(promptInput),
      kind: "procedure",
      parentRunId: this.params.run.run.runId,
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
        run: childRun,
        promptInput,
        ...binding,
      });
      const rawResult = await procedure.execute(prompt, childContext);
      const result = normalizeProcedureResult(rawResult);
      const finalized = this.params.store.completeRun(childRun, result);

      this.params.logger.write({
        spanId: childSpanId,
        parentSpanId: this.params.spanId,
        procedure: name,
        kind: "procedure_end",
        durationMs: Date.now() - startedAt,
        result: result.data,
        raw: result.display,
      });

      return toPublicRunResult(finalized) as RunResult<T>;
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
