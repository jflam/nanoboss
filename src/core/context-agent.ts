import type * as acp from "@agentclientprotocol/sdk";

import { collectTextSessionUpdates, summarizeAgentOutput } from "../agent/acp-updates.ts";
import { invokeAgent } from "../agent/call-agent.ts";
import { normalizeAgentTokenUsage } from "../agent/token-usage.ts";
import { promptInputDisplayText } from "./prompt.ts";
import type { SessionStore } from "@nanoboss/store";
import { RunCancelledError, defaultCancellationMessage, normalizeRunCancelledError } from "./cancellation.ts";
import { resolveDownstreamAgentConfig, toDownstreamAgentSelection } from "./config.ts";
import { formatErrorMessage } from "./error-format.ts";
import type { RunLogger } from "./logger.ts";
import { toPublicRunResult } from "./run-result.ts";
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
  Ref,
  RunResult,
  RunRef,
  TypeDescriptor,
} from "./types.ts";
import { publicKernelValueFromStored } from "./types.ts";

type ActiveRun = ReturnType<SessionStore["startRun"]>;

interface StartedAgentRun {
  childSpanId: string;
  startedAt: number;
  toolCallId?: string;
  emitToolCallEvents: boolean;
  childRun: ActiveRun;
}

interface AgentRunRecorderParams {
  logger: RunLogger;
  store: SessionStore;
  emitter: SessionUpdateEmitter;
  procedureName: string;
  spanId: string;
  run: ActiveRun;
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
      promptInput?: CommandCallAgentOptions["promptInput"];
    },
  ): StartedAgentRun {
    const started: StartedAgentRun = {
      childSpanId: this.params.logger.newSpan(this.params.spanId),
      startedAt: Date.now(),
      toolCallId: params.emitToolCallEvents ? crypto.randomUUID() : undefined,
      emitToolCallEvents: params.emitToolCallEvents,
      childRun: this.params.store.startRun({
        procedure: "callAgent",
        input: prompt,
        kind: "agent",
        parentRunId: this.params.run.run.runId,
        promptImages: params.promptInput ? this.params.store.persistPromptImages(params.promptInput) : undefined,
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
        _meta: {
          nanoboss: {
            toolKind: "wrapper",
            removeOnTerminal: true,
          },
        },
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
    const finalized = this.params.store.completeRun(started.childRun, {
      data: params.data,
      display: params.raw,
      summary: params.summary,
    }, {
      stream: params.streamText ? collectTextSessionUpdates(params.updates) : undefined,
      raw: params.raw,
    });
    const publicResult = toPublicRunResult(finalized);

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
        _meta: {
          nanoboss: {
            removeOnTerminal: true,
          },
        },
        rawOutput: {
          run: publicResult.run,
          dataRef: publicResult.dataRef,
          durationMs: params.durationMs,
          logFile: params.logFile,
          expandedContent: params.raw,
          ...params.rawOutputExtra,
        },
      });
    }

    return publicResult;
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
    this.params.store.discardPendingPromptImages(started.childRun.meta.promptImages);

    if (started.emitToolCallEvents && started.toolCallId) {
      this.params.emitter.emit({
        sessionUpdate: "tool_call_update",
        toolCallId: started.toolCallId,
        status: "failed",
        _meta: {
          nanoboss: {
            removeOnTerminal: true,
          },
        },
        rawOutput: {
          error: message,
          ...(cancelled ? { cancelled: true } : {}),
        },
      });
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
    const promptInput = options?.promptInput;
    const displayPrompt = promptInput ? promptInputDisplayText(promptInput) : prompt;
    this.params.assertCanStartBoundary();
    const useDefaultSession = sessionMode === "default"
      && !options?.persistedSessionId
      && this.params.sessionManager.hasDefaultAgentSession();
    const agentConfig = useDefaultSession && options?.agent
      ? this.params.sessionManager.setDefaultAgentSelection(options.agent)
      : options?.agent
        ? resolveDownstreamAgentConfig(this.params.cwd, options.agent)
        : this.params.sessionManager.getDefaultAgentConfig();
    const started = this.params.recorder.begin(displayPrompt, useDefaultSession
      ? {
          emitToolCallEvents: false,
          agent: options?.agent,
          promptInput,
        }
      : {
          title: `callAgent${formatAgentLabel(options?.agent)}: ${summarizeText(displayPrompt, 60)}`,
          rawInput: {
            prompt: displayPrompt,
            agent: options?.agent,
            refs: options?.refs,
          },
          emitToolCallEvents: true,
          agent: options?.agent,
          promptInput,
        });
    const namedRefs = resolveNamedRefs(this.params.store, options?.refs);
    const transport = this.params.sessionManager.createCallAgentTransport(sessionMode, this.params.timingTrace);

    try {
      const result = await invokeAgent(prompt, descriptor, {
        config: agentConfig,
        persistedSessionId: options?.persistedSessionId,
        namedRefs,
        signal: this.params.signal,
        softStopSignal: this.params.softStopSignal,
        promptInput,
        onUpdate: async (update) => {
          if (shouldForwardNestedAgentUpdate(update, options?.stream !== false)) {
            this.params.emitter.emit(withNestedToolCallMetadata(update, started.toolCallId));
          }
        },
      }, transport);

      const tokenUsageExtra = result.tokenSnapshot
        ? {
            tokenSnapshot: result.tokenSnapshot,
            tokenUsage: normalizeAgentTokenUsage(result.tokenSnapshot, agentConfig),
          }
        : undefined;

      const recorded = this.params.recorder.complete(started, {
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
              sessionId: this.params.sessionManager.getDefaultAgentSessionId(),
              ...tokenUsageExtra,
            }
          : tokenUsageExtra,
        agent: options?.agent,
      });

      return {
        ...recorded,
        ...(tokenUsageExtra?.tokenUsage ? { tokenUsage: tokenUsageExtra.tokenUsage } : {}),
        defaultAgentSelection: toDownstreamAgentSelection(agentConfig),
      };
    } catch (error) {
      return this.params.recorder.fail(started, error, options?.agent);
    }
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
  refs: Record<string, RunRef | Ref> | undefined,
): Record<string, unknown> | undefined {
  if (!refs || Object.keys(refs).length === 0) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(refs).map(([name, ref]) => [
      name,
      isRef(ref)
        ? publicKernelValueFromStored(store.readRef(ref) as KernelValue)
        : store.getRun(ref),
    ]),
  );
}

function isRef(value: RunRef | Ref): value is Ref {
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

function withNestedToolCallMetadata(
  update: acp.SessionUpdate,
  parentToolCallId?: string,
): acp.SessionUpdate {
  if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") {
    return update;
  }

  const metadata = getNestedToolCallMetadata(update, parentToolCallId);
  if (!metadata) {
    return update;
  }

  return {
    ...update,
    _meta: mergeNanobossToolMeta(update._meta, metadata),
  };
}

function getNestedToolCallMetadata(
  update: Extract<acp.SessionUpdate, { sessionUpdate: "tool_call" | "tool_call_update" }>,
  parentToolCallId?: string,
): Record<string, unknown> | undefined {
  const existingNanobossMeta = getNanobossMeta(update._meta);
  const nextMetadata: Record<string, unknown> = {};

  if (parentToolCallId && typeof existingNanobossMeta?.parentToolCallId !== "string") {
    nextMetadata.parentToolCallId = parentToolCallId;
  }

  const title = typeof update.title === "string" ? update.title : undefined;
  if (
    title
    && isInternalProcedureDispatchToolTitle(title)
    && typeof existingNanobossMeta?.transcriptVisible !== "boolean"
  ) {
    nextMetadata.transcriptVisible = false;
  }

  if (
    title
    && isInternalProcedureDispatchToolTitle(title)
    && typeof existingNanobossMeta?.removeOnTerminal !== "boolean"
  ) {
    nextMetadata.removeOnTerminal = true;
  }

  return Object.keys(nextMetadata).length > 0 ? nextMetadata : undefined;
}

function isInternalProcedureDispatchToolTitle(title: string): boolean {
  return title.includes("procedure_dispatch_start") || title.includes("procedure_dispatch_wait");
}

function mergeNanobossToolMeta(
  meta: acp.SessionUpdate["_meta"],
  nanobossFields: Record<string, unknown>,
): NonNullable<acp.SessionUpdate["_meta"]> {
  const base = meta && typeof meta === "object" ? meta : {};
  const existingNanoboss = getNanobossMeta(base);
  return {
    ...base,
    nanoboss: {
      ...(existingNanoboss ?? {}),
      ...nanobossFields,
    },
  };
}

function getNanobossMeta(meta: unknown): Record<string, unknown> | undefined {
  if (!meta || typeof meta !== "object") {
    return undefined;
  }

  const nanoboss = "nanoboss" in meta ? meta.nanoboss : undefined;
  return nanoboss && typeof nanoboss === "object"
    ? nanoboss as Record<string, unknown>
    : undefined;
}
