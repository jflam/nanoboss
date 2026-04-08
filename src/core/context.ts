import type * as acp from "@agentclientprotocol/sdk";

import { collectTextSessionUpdates, summarizeAgentOutput } from "../agent/acp-updates.ts";
import { invokeAgent } from "../agent/call-agent.ts";
import { RunCancelledError, defaultCancellationMessage, normalizeRunCancelledError } from "./cancellation.ts";
import { resolveDownstreamAgentConfig } from "./config.ts";
import { formatErrorMessage } from "./error-format.ts";
import type { DefaultConversationSession } from "../agent/default-session.ts";
import type { RunLogger } from "./logger.ts";
import { normalizeAgentTokenUsage } from "../agent/token-usage.ts";
import {
  normalizeProcedureResult,
} from "../session/index.ts";
import type { SessionStore } from "../session/index.ts";
import { summarizeText } from "../util/text.ts";
import type {
  CellAncestorsOptions,
  CellDescendantsOptions,
  CellRef,
  CommandCallAgentOptions,
  CommandContext,
  DownstreamAgentConfig,
  DownstreamAgentSelection,
  ProcedureRegistryLike,
  KernelValue,
  RefsApi,
  RunResult,
  SessionApi,
  SessionRecentOptions,
  TopLevelRunsOptions,
  TypeDescriptor,
  ValueRef,
} from "./types.ts";

type ActiveCell = ReturnType<SessionStore["startCell"]>;

interface StartedAgentRun {
  childSpanId: string;
  startedAt: number;
  toolCallId: string;
  childCell: ActiveCell;
}

export interface SessionUpdateEmitter {
  emit(update: acp.SessionUpdate): void;
  flush(): Promise<void>;
}

interface PreparedDefaultPrompt {
  prompt: string;
  markSubmitted?: () => void;
}

interface CommandContextParams {
  cwd: string;
  sessionId?: string;
  logger: RunLogger;
  registry: ProcedureRegistryLike;
  procedureName: string;
  spanId: string;
  emitter: SessionUpdateEmitter;
  store: SessionStore;
  cell: ActiveCell;
  signal?: AbortSignal;
  softStopSignal?: AbortSignal;
  defaultConversation?: DefaultConversationSession;
  getDefaultAgentConfig?: () => DownstreamAgentConfig;
  setDefaultAgentSelection?: (selection: DownstreamAgentSelection) => DownstreamAgentConfig;
  prepareDefaultPrompt?: (prompt: string) => PreparedDefaultPrompt;
  assertCanStartBoundary?: () => void;
}

export class CommandContextImpl implements CommandContext {
  readonly cwd: string;
  readonly sessionId: string;
  readonly refs: RefsApi;
  readonly session: SessionApi;

  private readonly logger: RunLogger;
  private readonly registry: ProcedureRegistryLike;
  private readonly procedureName: string;
  private readonly spanId: string;
  private readonly emitter: SessionUpdateEmitter;
  private readonly signal?: AbortSignal;
  private readonly softStopSignal?: AbortSignal;
  private readonly store: SessionStore;
  private readonly cell: ActiveCell;
  private readonly defaultConversation?: DefaultConversationSession;
  private readonly getDefaultAgentConfigValue: () => DownstreamAgentConfig;
  private readonly setDefaultAgentSelectionValue: (selection: DownstreamAgentSelection) => DownstreamAgentConfig;
  private readonly prepareDefaultPromptValue?: (prompt: string) => PreparedDefaultPrompt;
  private readonly assertCanStartBoundaryValue?: () => void;

  constructor(params: CommandContextParams) {
    this.cwd = params.cwd;
    this.sessionId = params.sessionId ?? params.store.sessionId;
    this.logger = params.logger;
    this.registry = params.registry;
    this.procedureName = params.procedureName;
    this.spanId = params.spanId;
    this.emitter = params.emitter;
    this.signal = params.signal;
    this.softStopSignal = params.softStopSignal;
    this.store = params.store;
    this.cell = params.cell;
    this.defaultConversation = params.defaultConversation;
    this.getDefaultAgentConfigValue = params.getDefaultAgentConfig
      ?? (() => resolveDownstreamAgentConfig(this.cwd));
    this.setDefaultAgentSelectionValue = params.setDefaultAgentSelection
      ?? ((selection) => resolveDownstreamAgentConfig(this.cwd, selection));
    this.prepareDefaultPromptValue = params.prepareDefaultPrompt;
    this.assertCanStartBoundaryValue = params.assertCanStartBoundary;
    this.refs = new CommandRefs(this.store, this.cwd);
    this.session = new CommandSession(this.store, this.cell.cell.cellId);
  }

  getDefaultAgentConfig(): DownstreamAgentConfig {
    return this.getDefaultAgentConfigValue();
  }

  setDefaultAgentSelection(selection: DownstreamAgentSelection): DownstreamAgentConfig {
    return this.setDefaultAgentSelectionValue(selection);
  }

  async getDefaultAgentTokenSnapshot() {
    return await this.defaultConversation?.getCurrentTokenSnapshot();
  }

  async getDefaultAgentTokenUsage() {
    return normalizeAgentTokenUsage(
      await this.defaultConversation?.getCurrentTokenSnapshot(),
      this.getDefaultAgentConfigValue(),
    );
  }

  assertNotCancelled(): void {
    this.assertCanStartBoundary();
  }

  async callAgent(
    prompt: string,
    options?: CommandCallAgentOptions,
  ): Promise<RunResult<string>>;
  async callAgent<T extends KernelValue>(
    prompt: string,
    descriptor: TypeDescriptor<T>,
    options?: CommandCallAgentOptions,
  ): Promise<RunResult<T>>;
  async callAgent<T extends KernelValue>(
    prompt: string,
    descriptorOrOptions?: TypeDescriptor<T> | CommandCallAgentOptions,
    maybeOptions?: CommandCallAgentOptions,
  ): Promise<RunResult<T> | RunResult<string>> {
    const descriptor = isTypeDescriptor(descriptorOrOptions)
      ? descriptorOrOptions
      : undefined;
    const options = (descriptor ? maybeOptions : descriptorOrOptions) as CommandCallAgentOptions | undefined;
    const agentConfig = options?.agent
      ? resolveDownstreamAgentConfig(this.cwd, options.agent)
      : this.getDefaultAgentConfigValue();
    const started = this.beginAgentRun(prompt, {
      title: `callAgent${formatAgentLabel(options?.agent)}: ${summarizeText(prompt, 60)}`,
      rawInput: {
        prompt,
        agent: options?.agent,
        refs: options?.refs,
      },
      agent: options?.agent,
    });
    const namedRefs = resolveNamedRefs(this.store, options?.refs);

    try {
      const result = await invokeAgent(prompt, descriptor, {
        config: agentConfig,
        namedRefs,
        signal: this.signal,
        softStopSignal: this.softStopSignal,
        onUpdate: async (update) => {
          if (shouldForwardNestedAgentUpdate(update, options?.stream !== false)) {
            this.emitter.emit(update);
          }
        },
      });

      return this.completeAgentRun(started, {
        data: result.data,
        raw: result.raw,
        updates: result.updates,
        durationMs: result.durationMs,
        logFile: result.logFile,
        summary: summarizeAgentOutput(result.data, result.raw),
        streamText: options?.stream !== false,
        rawOutputExtra: result.tokenSnapshot
          ? {
              tokenSnapshot: result.tokenSnapshot,
              tokenUsage: normalizeAgentTokenUsage(result.tokenSnapshot, agentConfig),
            }
          : undefined,
        agent: options?.agent,
      });
    } catch (error) {
      return this.failAgentRun(started, error, options?.agent);
    }
  }

  async callProcedure<T extends KernelValue = never>(
    name: string,
    prompt: string,
  ): Promise<RunResult<T>> {
    const procedure = this.registry.get(name);
    if (!procedure) {
      throw new Error(`Unknown procedure: ${name}`);
    }

    const childSpanId = this.logger.newSpan(this.spanId);
    const startedAt = Date.now();
    this.assertCanStartBoundary();
    const childCell = this.store.startCell({
      procedure: name,
      input: prompt,
      kind: "procedure",
      parentCellId: this.cell.cell.cellId,
    });

    this.logger.write({
      spanId: childSpanId,
      parentSpanId: this.spanId,
      procedure: name,
      kind: "procedure_start",
      prompt,
    });

    try {
      const childContext = new CommandContextImpl({
        cwd: this.cwd,
        sessionId: this.sessionId,
        logger: this.logger,
        registry: this.registry,
        procedureName: name,
        spanId: childSpanId,
        emitter: this.emitter,
        store: this.store,
        cell: childCell,
        signal: this.signal,
        softStopSignal: this.softStopSignal,
        defaultConversation: this.defaultConversation,
        getDefaultAgentConfig: this.getDefaultAgentConfigValue,
        setDefaultAgentSelection: this.setDefaultAgentSelectionValue,
        prepareDefaultPrompt: this.prepareDefaultPromptValue,
        assertCanStartBoundary: this.assertCanStartBoundaryValue,
      });
      const rawResult = await procedure.execute(prompt, childContext);
      const result = normalizeProcedureResult(rawResult);
      const finalized = this.store.finalizeCell(childCell, result);

      this.logger.write({
        spanId: childSpanId,
        parentSpanId: this.spanId,
        procedure: name,
        kind: "procedure_end",
        durationMs: Date.now() - startedAt,
        result: result.data,
        raw: result.display,
      });

      return finalized as RunResult<T>;
    } catch (error) {
      this.logger.write({
        spanId: childSpanId,
        parentSpanId: this.spanId,
        procedure: name,
        kind: "procedure_end",
        durationMs: Date.now() - startedAt,
        error: formatErrorMessage(error),
      });
      throw error;
    }
  }

  async continueDefaultSession(prompt: string): Promise<RunResult<string>> {
    if (!this.defaultConversation) {
      return this.callAgent(prompt);
    }

    const started = this.beginAgentRun(prompt, {
      title: "Calling default procedure",
      rawInput: {
        callPreview: {
          header: "Calling default procedure",
        },
      },
    });
    const preparedPrompt = this.prepareDefaultPromptValue?.(prompt) ?? { prompt };

    try {
      const result = await this.defaultConversation.prompt(preparedPrompt.prompt, {
        signal: this.signal,
        softStopSignal: this.softStopSignal,
        onUpdate: async (update) => {
          if (
            update.sessionUpdate === "agent_message_chunk" ||
            update.sessionUpdate === "tool_call" ||
            update.sessionUpdate === "tool_call_update" ||
            update.sessionUpdate === "usage_update"
          ) {
            this.emitter.emit(update);
          }
        },
      });

      const finalized = this.completeAgentRun(started, {
        data: result.raw,
        raw: result.raw,
        updates: result.updates,
        durationMs: result.durationMs,
        logFile: result.logFile,
        summary: summarizeText(result.raw),
        streamText: true,
        rawOutputExtra: {
          sessionId: this.defaultConversation.currentSessionId,
          ...(result.tokenSnapshot
            ? {
                tokenSnapshot: result.tokenSnapshot,
                tokenUsage: normalizeAgentTokenUsage(result.tokenSnapshot, this.getDefaultAgentConfigValue()),
              }
            : {}),
        },
      });

      preparedPrompt.markSubmitted?.();
      return finalized;
    } catch (error) {
      return this.failAgentRun(started, error);
    }
  }

  private beginAgentRun(
    prompt: string,
    params: {
      title: string;
      rawInput: unknown;
      agent?: DownstreamAgentSelection;
    },
  ): StartedAgentRun {
    this.assertCanStartBoundary();

    const started: StartedAgentRun = {
      childSpanId: this.logger.newSpan(this.spanId),
      startedAt: Date.now(),
      toolCallId: crypto.randomUUID(),
      childCell: this.store.startCell({
        procedure: "callAgent",
        input: prompt,
        kind: "agent",
        parentCellId: this.cell.cell.cellId,
      }),
    };

    this.logger.write({
      spanId: started.childSpanId,
      parentSpanId: this.spanId,
      procedure: this.procedureName,
      kind: "agent_start",
      prompt,
      agentProvider: params.agent?.provider,
      agentModel: params.agent?.model,
    });

    this.emitter.emit({
      sessionUpdate: "tool_call",
      toolCallId: started.toolCallId,
      title: params.title,
      kind: "other",
      status: "pending",
      rawInput: params.rawInput,
    });

    return started;
  }

  private completeAgentRun<T extends KernelValue>(
    started: StartedAgentRun,
    params: {
      data: T;
      raw: string;
      updates: acp.SessionUpdate[];
      durationMs: number;
      logFile?: string;
      summary?: string;
      streamText: boolean;
      rawOutputExtra?: Record<string, unknown>;
      agent?: DownstreamAgentSelection;
    },
  ): RunResult<T> {
    const finalized = this.store.finalizeCell(started.childCell, {
      data: params.data,
      display: params.raw,
      summary: params.summary,
    }, {
      stream: params.streamText ? collectTextSessionUpdates(params.updates) : undefined,
      raw: params.raw,
    });

    this.logger.write({
      spanId: started.childSpanId,
      parentSpanId: this.spanId,
      procedure: this.procedureName,
      kind: "agent_end",
      durationMs: Date.now() - started.startedAt,
      result: params.data,
      raw: params.raw,
      agentLogFile: params.logFile,
      agentProvider: params.agent?.provider,
      agentModel: params.agent?.model,
    });

    this.emitter.emit({
      sessionUpdate: "tool_call_update",
      toolCallId: started.toolCallId,
      status: "completed",
      rawOutput: {
        cell: finalized.cell,
        dataRef: finalized.dataRef,
        durationMs: params.durationMs,
        logFile: params.logFile,
        expandedContent: params.raw,
        ...params.rawOutputExtra,
      },
    });

    return finalized;
  }

  private failAgentRun(
    started: StartedAgentRun,
    error: unknown,
    agent?: DownstreamAgentSelection,
  ): never {
    const cancelled = normalizeRunCancelledError(
      error,
      this.softStopSignal?.aborted ? "soft_stop" : "abort",
    );
    const message = cancelled?.message ?? formatErrorMessage(error);

    this.logger.write({
      spanId: started.childSpanId,
      parentSpanId: this.spanId,
      procedure: this.procedureName,
      kind: "agent_end",
      durationMs: Date.now() - started.startedAt,
      error: message,
      agentProvider: agent?.provider,
      agentModel: agent?.model,
    });

    this.emitter.emit({
      sessionUpdate: "tool_call_update",
      toolCallId: started.toolCallId,
      status: cancelled ? "cancelled" : "failed",
      rawOutput: { error: message },
    });

    throw cancelled ?? error;
  }

  private assertCanStartBoundary(): void {
    this.assertCanStartBoundaryValue?.();

    if (this.softStopSignal?.aborted) {
      throw new RunCancelledError(defaultCancellationMessage("soft_stop"), "soft_stop");
    }

    if (this.signal?.aborted) {
      throw new RunCancelledError(defaultCancellationMessage("abort"), "abort");
    }
  }

  print(text: string): void {
    this.store.appendStream(this.cell, text);
    this.logger.write({
      spanId: this.spanId,
      parentSpanId: undefined,
      procedure: this.procedureName,
      kind: "print",
      raw: text,
    });
    this.emitter.emit({
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text,
      },
    });
  }
}

class CommandRefs implements RefsApi {
  constructor(
    private readonly store: SessionStore,
    private readonly cwd: string,
  ) {}

  async read<T>(valueRef: ValueRef): Promise<T> {
    return this.store.readRef(valueRef) as T;
  }

  async stat(valueRef: ValueRef) {
    return this.store.statRef(valueRef);
  }

  async writeToFile(valueRef: ValueRef, path: string): Promise<void> {
    this.store.writeRefToFile(valueRef, path, this.cwd);
  }
}

class CommandSession implements SessionApi {
  constructor(
    private readonly store: SessionStore,
    private readonly currentCellId: string,
  ) {}

  async recent(options?: SessionRecentOptions) {
    return this.store.recent({
      ...options,
      excludeCellId: this.currentCellId,
    });
  }

  async topLevelRuns(options?: TopLevelRunsOptions) {
    return this.store.topLevelRuns(options);
  }

  async get(cellRef: CellRef) {
    return this.store.readCell(cellRef);
  }

  async ancestors(cellRef: CellRef, options?: CellAncestorsOptions) {
    return this.store.ancestors(cellRef, options);
  }

  async descendants(cellRef: CellRef, options?: CellDescendantsOptions) {
    return this.store.descendants(cellRef, options);
  }
}

function formatAgentLabel(agent?: DownstreamAgentSelection): string {
  if (!agent) {
    return "";
  }

  return agent.model ? ` [${agent.provider}:${agent.model}]` : ` [${agent.provider}]`;
}

function isTypeDescriptor<T>(value: unknown): value is TypeDescriptor<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    "schema" in value &&
    "validate" in value &&
    typeof (value as { validate: unknown }).validate === "function"
  );
}

function resolveNamedRefs(
  store: SessionStore,
  refs: Record<string, CellRef | ValueRef> | undefined,
): Record<string, unknown> | undefined {
  if (!refs || Object.keys(refs).length === 0) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(refs).map(([name, ref]) => [
      name,
      isValueRef(ref) ? store.readRef(ref) : store.readCell(ref),
    ]),
  );
}

function isValueRef(value: CellRef | ValueRef): value is ValueRef {
  return "path" in value;
}

function shouldForwardNestedAgentUpdate(
  update: acp.SessionUpdate,
  streamText: boolean,
): boolean {
  if (update.sessionUpdate === "agent_message_chunk") {
    return streamText;
  }

  return (
    update.sessionUpdate === "tool_call" ||
    update.sessionUpdate === "tool_call_update" ||
    update.sessionUpdate === "usage_update"
  );
}
