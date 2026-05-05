import type * as acp from "@agentclientprotocol/sdk";

import { collectTextSessionUpdates } from "@nanoboss/agent-acp";
import type { DownstreamAgentSelection, KernelValue } from "@nanoboss/procedure-sdk";
import {
  formatErrorMessage,
  toCancelledError,
  type CommandCallAgentOptions,
} from "@nanoboss/procedure-sdk";
import type { SessionStore } from "@nanoboss/store";
import { appendTimingTraceEvent, type RunTimingTrace } from "@nanoboss/app-support";

import type { RunLogger } from "../logger.ts";
import { toPublicRunResult } from "../run-result.ts";
import {
  buildStructuredOutputToolOutput,
  emitStructuredOutputProcedurePanel,
} from "./agent-output-events.ts";
import type { SessionUpdateEmitter } from "./shared.ts";

type ActiveRun = ReturnType<SessionStore["startRun"]>;

interface StartedAgentRun {
  childSpanId: string;
  startedAt: number;
  toolCallId?: string;
  emitToolCallEvents: boolean;
  structuredOutput: boolean;
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
      structuredOutput: boolean;
      agent?: DownstreamAgentSelection;
      promptInput?: CommandCallAgentOptions["promptInput"];
    },
  ): StartedAgentRun {
    const started: StartedAgentRun = {
      childSpanId: this.params.logger.newSpan(this.params.spanId),
      startedAt: Date.now(),
      toolCallId: params.emitToolCallEvents ? crypto.randomUUID() : undefined,
      emitToolCallEvents: params.emitToolCallEvents,
      structuredOutput: params.structuredOutput,
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
      explicitDataSchema?: object;
      rawOutputExtra?: Record<string, unknown>;
      agent?: DownstreamAgentSelection;
    },
  ) {
    const finalized = this.params.store.completeRun(started.childRun, {
      data: params.data,
      display: params.raw,
      summary: params.summary,
      explicitDataSchema: params.explicitDataSchema,
    }, {
      agentUpdates: params.updates,
      stream: params.streamText ? collectTextSessionUpdates(params.updates) : undefined,
      raw: params.raw,
    });
    const publicResult = toPublicRunResult(finalized);
    const structuredOutputPreview = started.structuredOutput
      ? buildStructuredOutputToolOutput(publicResult)
      : { expandedContent: params.raw };

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
          ...structuredOutputPreview,
          ...params.rawOutputExtra,
        },
      });
    }

    if (started.structuredOutput && !started.emitToolCallEvents) {
      emitStructuredOutputProcedurePanel(this.params.emitter, this.params.procedureName, publicResult);
    }

    return publicResult;
  }

  fail(
    started: StartedAgentRun,
    error: unknown,
    agent?: DownstreamAgentSelection,
  ): never {
    const cancelled = toCancelledError(error, this.params);
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
