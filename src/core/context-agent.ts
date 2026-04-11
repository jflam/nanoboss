import type * as acp from "@agentclientprotocol/sdk";

import { collectTextSessionUpdates, summarizeAgentOutput } from "../agent/acp-updates.ts";
import { invokeAgent } from "../agent/call-agent.ts";
import { normalizeAgentTokenUsage } from "../agent/token-usage.ts";
import type { SessionStore } from "../session/index.ts";
import { RunCancelledError, defaultCancellationMessage, normalizeRunCancelledError } from "./cancellation.ts";
import { resolveDownstreamAgentConfig } from "./config.ts";
import { formatErrorMessage } from "./error-format.ts";
import type { RunLogger } from "./logger.ts";
import { appendTimingTraceEvent, type RunTimingTrace } from "./timing-trace.ts";
import type { ContextSessionApiImpl } from "./context-session.ts";
import type { SessionUpdateEmitter } from "./context-shared.ts";
import { summarizeText } from "../util/text.ts";
import type {
  AgentInvocationApi,
  AgentSessionMode,
  BoundAgentInvocationApi,
  CommandCallAgentOptions,
  DownstreamAgentSelection,
  KernelValue,
  RunResult,
  TypeDescriptor,
} from "./types.ts";

type ActiveCell = ReturnType<SessionStore["startCell"]>;

interface StartedAgentRun {
  childSpanId: string;
  startedAt: number;
  toolCallId?: string;
  emitToolCallEvents: boolean;
  childCell: ActiveCell;
}

interface AgentRunRecorderParams {
  logger: RunLogger;
  store: SessionStore;
  emitter: SessionUpdateEmitter;
  procedureName: string;
  spanId: string;
  cell: ActiveCell;
  softStopSignal?: AbortSignal;
  timingTrace?: RunTimingTrace;
}

export class AgentRunRecorder {
  constructor(private readonly params: AgentRunRecorderParams) {}

  begin(
    prompt: string,
    params: {
      title?: string;
      rawInput?: unknown;
      emitToolCallEvents: boolean;
      agent?: DownstreamAgentSelection;
    },
  ): StartedAgentRun {
    const started: StartedAgentRun = {
      childSpanId: this.params.logger.newSpan(this.params.spanId),
      startedAt: Date.now(),
      toolCallId: params.emitToolCallEvents ? crypto.randomUUID() : undefined,
      emitToolCallEvents: params.emitToolCallEvents,
      childCell: this.params.store.startCell({
        procedure: "callAgent",
        input: prompt,
        kind: "agent",
        parentCellId: this.params.cell.cell.cellId,
      }),
    };

    this.params.logger.write({
      spanId: started.childSpanId,
      parentSpanId: this.params.spanId,
      procedure: this.params.procedureName,
      kind: "agent_start",
      prompt,
      agentProvider: params.agent?.provider,
      agentModel: params.agent?.model,
    });
    appendTimingTraceEvent(this.params.timingTrace, "context", "agent_run_started", {
      procedure: this.params.procedureName,
      agentProvider: params.agent?.provider,
      agentModel: params.agent?.model,
      sessionMode: params.emitToolCallEvents ? "fresh" : "default",
      title: params.title,
    });
    if (this.params.timingTrace && !this.params.timingTrace.shared.firstAgentActionRecorded) {
      this.params.timingTrace.shared.firstAgentActionRecorded = true;
      appendTimingTraceEvent(this.params.timingTrace, "context", "first_agent_action", {
        procedure: this.params.procedureName,
        sessionMode: params.emitToolCallEvents ? "fresh" : "default",
        title: params.title,
      });
    }

    if (started.emitToolCallEvents && started.toolCallId && params.title) {
      this.params.emitter.emit({
        sessionUpdate: "tool_call",
        toolCallId: started.toolCallId,
        title: params.title,
        kind: "other",
        status: "pending",
        rawInput: params.rawInput,
      });
    }

    return started;
  }

  complete<T extends KernelValue>(
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
  ) {
    const finalized = this.params.store.finalizeCell(started.childCell, {
      data: params.data,
      display: params.raw,
      summary: params.summary,
    }, {
      stream: params.streamText ? collectTextSessionUpdates(params.updates) : undefined,
      raw: params.raw,
    });

    this.params.logger.write({
      spanId: started.childSpanId,
      parentSpanId: this.params.spanId,
      procedure: this.params.procedureName,
      kind: "agent_end",
      durationMs: Date.now() - started.startedAt,
      result: params.data,
      raw: params.raw,
      agentLogFile: params.logFile,
      agentProvider: params.agent?.provider,
      agentModel: params.agent?.model,
    });

    if (started.emitToolCallEvents && started.toolCallId) {
      this.params.emitter.emit({
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
    }

    return finalized;
  }

  fail(
    started: StartedAgentRun,
    error: unknown,
    agent?: DownstreamAgentSelection,
  ): never {
    const cancelled = normalizeRunCancelledError(
      error,
      this.params.softStopSignal?.aborted ? "soft_stop" : "abort",
    );
    const message = cancelled?.message ?? formatErrorMessage(error);

    this.params.logger.write({
      spanId: started.childSpanId,
      parentSpanId: this.params.spanId,
      procedure: this.params.procedureName,
      kind: "agent_end",
      durationMs: Date.now() - started.startedAt,
      error: message,
      agentProvider: agent?.provider,
      agentModel: agent?.model,
    });

    if (started.emitToolCallEvents && started.toolCallId) {
      this.params.emitter.emit({
        sessionUpdate: "tool_call_update",
        toolCallId: started.toolCallId,
        status: cancelled ? "cancelled" : "failed",
        rawOutput: { error: message },
      } as acp.SessionUpdate);
    }

    throw cancelled ?? error;
  }
}

interface AgentInvocationApiImplParams {
  cwd: string;
  signal?: AbortSignal;
  softStopSignal?: AbortSignal;
  store: SessionStore;
  emitter: SessionUpdateEmitter;
  sessionManager: ContextSessionApiImpl;
  assertCanStartBoundary: () => void;
  recorder: AgentRunRecorder;
  timingTrace?: RunTimingTrace;
}

export class AgentInvocationApiImpl implements AgentInvocationApi {
  constructor(private readonly params: AgentInvocationApiImplParams) {}

  session(mode: AgentSessionMode): BoundAgentInvocationApi {
    return new BoundAgentInvocationApiImpl(this, mode);
  }

  async run(
    prompt: string,
    options?: CommandCallAgentOptions,
  ): Promise<RunResult<string>>;
  async run<T extends KernelValue>(
    prompt: string,
    descriptor: TypeDescriptor<T>,
    options?: CommandCallAgentOptions,
  ): Promise<RunResult<T>>;
  async run<T extends KernelValue>(
    prompt: string,
    descriptorOrOptions?: TypeDescriptor<T> | CommandCallAgentOptions,
    maybeOptions?: CommandCallAgentOptions,
  ) {
    const descriptor = isTypeDescriptor(descriptorOrOptions)
      ? descriptorOrOptions
      : undefined;
    const options = (descriptor ? maybeOptions : descriptorOrOptions) as CommandCallAgentOptions | undefined;
    const sessionMode = options?.session ?? "fresh";
    this.params.assertCanStartBoundary();
    const useDefaultSession = sessionMode === "default" && this.params.sessionManager.hasDefaultConversation();
    const agentConfig = useDefaultSession && options?.agent
      ? this.params.sessionManager.setDefaultAgentSelection(options.agent)
      : options?.agent
        ? resolveDownstreamAgentConfig(this.params.cwd, options.agent)
        : this.params.sessionManager.getDefaultAgentConfig();
    const started = this.params.recorder.begin(prompt, useDefaultSession
      ? {
          emitToolCallEvents: false,
          agent: options?.agent,
        }
      : {
          title: `callAgent${formatAgentLabel(options?.agent)}: ${summarizeText(prompt, 60)}`,
          rawInput: {
            prompt,
            agent: options?.agent,
            refs: options?.refs,
          },
          emitToolCallEvents: true,
          agent: options?.agent,
        });
    const namedRefs = resolveNamedRefs(this.params.store, options?.refs);
    const transport = this.params.sessionManager.createCallAgentTransport(sessionMode, this.params.timingTrace);

    try {
      const result = await invokeAgent(prompt, descriptor, {
        config: agentConfig,
        namedRefs,
        signal: this.params.signal,
        softStopSignal: this.params.softStopSignal,
        runtimeCapabilityMode: this.params.sessionManager.getRuntimeCapabilityMode(),
        onUpdate: async (update) => {
          if (shouldForwardNestedAgentUpdate(update, options?.stream !== false)) {
            this.params.emitter.emit(update);
          }
        },
      }, transport);

      const tokenUsageExtra = result.tokenSnapshot
        ? {
            tokenSnapshot: result.tokenSnapshot,
            tokenUsage: normalizeAgentTokenUsage(result.tokenSnapshot, agentConfig),
          }
        : undefined;

      return this.params.recorder.complete(started, {
        data: result.data,
        raw: result.raw,
        updates: result.updates,
        durationMs: result.durationMs,
        logFile: result.logFile,
        summary: useDefaultSession && !descriptor
          ? summarizeText(result.raw)
          : summarizeAgentOutput(result.data, result.raw),
        streamText: options?.stream !== false,
        rawOutputExtra: useDefaultSession
          ? {
              sessionId: this.params.sessionManager.getDefaultConversationSessionId(),
              ...tokenUsageExtra,
            }
          : tokenUsageExtra,
        agent: options?.agent,
      });
    } catch (error) {
      return this.params.recorder.fail(started, error, options?.agent);
    }
  }

  async callAgent(
    prompt: string,
    descriptorOrOptions?: TypeDescriptor<KernelValue> | CommandCallAgentOptions,
    maybeOptions?: CommandCallAgentOptions,
  ) {
    const descriptor = isTypeDescriptor(descriptorOrOptions)
      ? descriptorOrOptions
      : undefined;
    const options = (descriptor ? maybeOptions : descriptorOrOptions) as CommandCallAgentOptions | undefined;

    return descriptor
      ? await this.run(prompt, descriptor, options)
      : await this.run(prompt, options);
  }
}

class BoundAgentInvocationApiImpl implements BoundAgentInvocationApi {
  constructor(
    private readonly agent: AgentInvocationApiImpl,
    private readonly sessionMode: AgentSessionMode,
  ) {}

  async run(
    prompt: string,
    options?: Omit<CommandCallAgentOptions, "session">,
  ): Promise<RunResult<string>>;
  async run<T extends KernelValue>(
    prompt: string,
    descriptor: TypeDescriptor<T>,
    options?: Omit<CommandCallAgentOptions, "session">,
  ): Promise<RunResult<T>>;
  async run<T extends KernelValue>(
    prompt: string,
    descriptorOrOptions?: TypeDescriptor<T> | Omit<CommandCallAgentOptions, "session">,
    maybeOptions?: Omit<CommandCallAgentOptions, "session">,
  ) {
    const descriptor = isTypeDescriptor(descriptorOrOptions)
      ? descriptorOrOptions
      : undefined;
    const options = (descriptor ? maybeOptions : descriptorOrOptions) as Omit<CommandCallAgentOptions, "session"> | undefined;
    const boundOptions: CommandCallAgentOptions = {
      ...(options ?? {}),
      session: this.sessionMode,
    };

    if (descriptor) {
      return await this.agent.run(prompt, descriptor, boundOptions);
    }

    return await this.agent.run(prompt, boundOptions);
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
  refs: Record<string, { sessionId: string; cellId: string } | { cell: { sessionId: string; cellId: string }; path: string }> | undefined,
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

function isValueRef(value: { sessionId: string; cellId: string } | { cell: { sessionId: string; cellId: string }; path: string }): value is { cell: { sessionId: string; cellId: string }; path: string } {
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
