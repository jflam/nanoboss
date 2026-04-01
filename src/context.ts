import type * as acp from "@agentclientprotocol/sdk";

import { invokeAgent } from "./call-agent.ts";
import { resolveDownstreamAgentConfig } from "./config.ts";
import type { DefaultConversationSession } from "./default-session.ts";
import type { RunLogger } from "./logger.ts";
import {
  normalizeProcedureResult,
  summarizeText,
} from "./session-store.ts";
import type { SessionStore } from "./session-store.ts";
import type {
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
  TypeDescriptor,
  ValueRef,
} from "./types.ts";

type ActiveCell = ReturnType<SessionStore["startCell"]>;

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
  defaultConversation?: DefaultConversationSession;
  getDefaultAgentConfig?: () => DownstreamAgentConfig;
  setDefaultAgentSelection?: (selection: DownstreamAgentSelection) => DownstreamAgentConfig;
  prepareDefaultPrompt?: (prompt: string) => PreparedDefaultPrompt;
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
  private readonly store: SessionStore;
  private readonly cell: ActiveCell;
  private readonly defaultConversation?: DefaultConversationSession;
  private readonly getDefaultAgentConfigValue: () => DownstreamAgentConfig;
  private readonly setDefaultAgentSelectionValue: (selection: DownstreamAgentSelection) => DownstreamAgentConfig;
  private readonly prepareDefaultPromptValue?: (prompt: string) => PreparedDefaultPrompt;

  constructor(params: CommandContextParams) {
    this.cwd = params.cwd;
    this.sessionId = params.sessionId ?? params.store.sessionId;
    this.logger = params.logger;
    this.registry = params.registry;
    this.procedureName = params.procedureName;
    this.spanId = params.spanId;
    this.emitter = params.emitter;
    this.signal = params.signal;
    this.store = params.store;
    this.cell = params.cell;
    this.defaultConversation = params.defaultConversation;
    this.getDefaultAgentConfigValue = params.getDefaultAgentConfig
      ?? (() => resolveDownstreamAgentConfig(this.cwd));
    this.setDefaultAgentSelectionValue = params.setDefaultAgentSelection
      ?? ((selection) => resolveDownstreamAgentConfig(this.cwd, selection));
    this.prepareDefaultPromptValue = params.prepareDefaultPrompt;
    this.refs = new CommandRefs(this.store, this.cwd);
    this.session = new CommandSession(this.store, this.cell.cell.cellId);
  }

  getDefaultAgentConfig(): DownstreamAgentConfig {
    return this.getDefaultAgentConfigValue();
  }

  setDefaultAgentSelection(selection: DownstreamAgentSelection): DownstreamAgentConfig {
    return this.setDefaultAgentSelectionValue(selection);
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
    const childSpanId = this.logger.newSpan(this.spanId);
    const startedAt = Date.now();
    const toolCallId = crypto.randomUUID();
    const agentLabel = formatAgentLabel(options?.agent);
    const childCell = this.store.startCell({
      procedure: "callAgent",
      input: prompt,
      kind: "agent",
      parentCellId: this.cell.cell.cellId,
    });
    const namedRefs = resolveNamedRefs(this.store, options?.refs);

    this.logger.write({
      spanId: childSpanId,
      parentSpanId: this.spanId,
      procedure: this.procedureName,
      kind: "agent_start",
      prompt,
      agentProvider: options?.agent?.provider,
      agentModel: options?.agent?.model,
    });

    this.emitter.emit({
      sessionUpdate: "tool_call",
      toolCallId,
      title: `callAgent${agentLabel}: ${summarize(prompt)}`,
      kind: "other",
      status: "pending",
      rawInput: {
        prompt,
        agent: options?.agent,
        refs: options?.refs,
      },
    });

    try {
      const result = await invokeAgent(prompt, descriptor, {
        config: options?.agent
          ? resolveDownstreamAgentConfig(this.cwd, options.agent)
          : this.getDefaultAgentConfigValue(),
        namedRefs,
        signal: this.signal,
        sessionMcp: {
          sessionId: this.sessionId,
          cwd: this.cwd,
          rootDir: this.store.rootDir,
        },
        onUpdate: async (update) => {
          if (shouldForwardNestedAgentUpdate(update, options?.stream !== false)) {
            this.emitter.emit(update);
          }
        },
      });

      const finalized = this.store.finalizeCell(childCell, {
        data: result.data,
        display: result.raw,
        summary: summarizeAgentResult(result.data, result.raw),
      }, {
        stream: options?.stream === false ? undefined : collectStreamText(result.updates),
        raw: result.raw,
      });

      this.logger.write({
        spanId: childSpanId,
        parentSpanId: this.spanId,
        procedure: this.procedureName,
        kind: "agent_end",
        durationMs: Date.now() - startedAt,
        result: result.data,
        raw: result.raw,
        agentLogFile: result.logFile,
        agentProvider: options?.agent?.provider,
        agentModel: options?.agent?.model,
      });

      this.emitter.emit({
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "completed",
        rawOutput: {
          cell: finalized.cell,
          dataRef: finalized.dataRef,
          durationMs: result.durationMs,
          logFile: result.logFile,
        },
      });

      return finalized;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      this.logger.write({
        spanId: childSpanId,
        parentSpanId: this.spanId,
        procedure: this.procedureName,
        kind: "agent_end",
        durationMs: Date.now() - startedAt,
        error: message,
        agentProvider: options?.agent?.provider,
        agentModel: options?.agent?.model,
      });

      this.emitter.emit({
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "failed",
        rawOutput: { error: message },
      });

      throw error;
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
        defaultConversation: this.defaultConversation,
        getDefaultAgentConfig: this.getDefaultAgentConfigValue,
        setDefaultAgentSelection: this.setDefaultAgentSelectionValue,
        prepareDefaultPrompt: this.prepareDefaultPromptValue,
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
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async continueDefaultSession(prompt: string): Promise<RunResult<string>> {
    if (!this.defaultConversation) {
      return this.callAgent(prompt);
    }

    const childSpanId = this.logger.newSpan(this.spanId);
    const startedAt = Date.now();
    const toolCallId = crypto.randomUUID();
    const childCell = this.store.startCell({
      procedure: "callAgent",
      input: prompt,
      kind: "agent",
      parentCellId: this.cell.cell.cellId,
    });

    this.logger.write({
      spanId: childSpanId,
      parentSpanId: this.spanId,
      procedure: this.procedureName,
      kind: "agent_start",
      prompt,
    });

    this.emitter.emit({
      sessionUpdate: "tool_call",
      toolCallId,
      title: `defaultSession: ${summarize(prompt)}`,
      kind: "other",
      status: "pending",
      rawInput: {
        prompt,
        sessionId: this.sessionId,
      },
    });

    const preparedPrompt = this.prepareDefaultPromptValue?.(prompt) ?? { prompt };

    try {
      const result = await this.defaultConversation.prompt(preparedPrompt.prompt, {
        signal: this.signal,
        onUpdate: async (update) => {
          if (
            update.sessionUpdate === "agent_message_chunk" ||
            update.sessionUpdate === "tool_call" ||
            update.sessionUpdate === "tool_call_update"
          ) {
            this.emitter.emit(update);
          }
        },
      });

      const finalized = this.store.finalizeCell(childCell, {
        data: result.raw,
        display: result.raw,
        summary: summarizeText(result.raw),
      }, {
        stream: collectStreamText(result.updates),
        raw: result.raw,
      });

      this.logger.write({
        spanId: childSpanId,
        parentSpanId: this.spanId,
        procedure: this.procedureName,
        kind: "agent_end",
        durationMs: Date.now() - startedAt,
        result: result.raw,
        raw: result.raw,
        agentLogFile: result.logFile,
      });

      this.emitter.emit({
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "completed",
        rawOutput: {
          cell: finalized.cell,
          dataRef: finalized.dataRef,
          durationMs: result.durationMs,
          logFile: result.logFile,
          sessionId: this.defaultConversation.currentSessionId,
        },
      });

      preparedPrompt.markSubmitted?.();
      return finalized;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      this.logger.write({
        spanId: childSpanId,
        parentSpanId: this.spanId,
        procedure: this.procedureName,
        kind: "agent_end",
        durationMs: Date.now() - startedAt,
        error: message,
      });

      this.emitter.emit({
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "failed",
        rawOutput: { error: message },
      });

      throw error;
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

  async last() {
    return this.store.last({ excludeCellId: this.currentCellId });
  }

  async recent(options?: { procedure?: string; limit?: number }) {
    return this.store.recent({
      ...options,
      excludeCellId: this.currentCellId,
    });
  }
}

function summarize(prompt: string): string {
  const compact = prompt.replace(/\s+/g, " ").trim();
  return compact.length > 60 ? `${compact.slice(0, 57)}...` : compact;
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

  return update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update";
}

function collectStreamText(updates: acp.SessionUpdate[]): string | undefined {
  let chunks = "";

  for (const update of updates) {
    if (update.sessionUpdate !== "agent_message_chunk" || update.content.type !== "text") {
      continue;
    }

    chunks += update.content.text;
  }

  return chunks || undefined;
}

function summarizeAgentResult(data: unknown, raw: string): string | undefined {
  if (typeof data === "string") {
    return summarizeText(data);
  }

  return summarizeText(raw);
}
