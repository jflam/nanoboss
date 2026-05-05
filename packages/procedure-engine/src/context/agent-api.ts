import {
  invokeAgent,
  normalizeAgentTokenUsage,
  summarizeAgentOutput,
  toDownstreamAgentSelection,
  type CallAgentTransport,
} from "@nanoboss/agent-acp";
import type { SessionStore } from "@nanoboss/store";
import type { ContextSessionApiImpl } from "./session-api.ts";
import type { SessionUpdateEmitter } from "./shared.ts";
import type {
  AgentSessionMode,
  AgentInvocationApi,
  BoundAgentInvocationApi,
  CommandCallAgentOptions,
  DownstreamAgentSelection,
  KernelValue,
  RunResult,
  TypeDescriptor,
} from "@nanoboss/procedure-sdk";
import {
  promptInputDisplayText,
  summarizeText,
} from "@nanoboss/procedure-sdk";

import { resolveDownstreamAgentConfig } from "../agent-config.ts";
import type { RunTimingTrace } from "@nanoboss/app-support";
import {
  shouldForwardNestedAgentUpdate,
  withNestedToolCallMetadata,
} from "./agent-output-events.ts";
import type { AgentRunRecorder } from "./agent-run-recorder.ts";
import { BoundAgentInvocationApiImpl } from "./bound-agent-invocation.ts";
import { resolveNamedRefs } from "./named-refs.ts";
import { isTypeDescriptor } from "./type-descriptor.ts";

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
    const structuredOutput = descriptor !== undefined;
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
          structuredOutput,
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
          structuredOutput,
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
          if (shouldForwardNestedAgentUpdate(
            update,
            options?.stream !== false,
            started.emitToolCallEvents,
            structuredOutput,
          )) {
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
        explicitDataSchema: descriptor?.schema,
        rawOutputExtra: useDefaultSession
          ? {
              sessionId: this.params.sessionManager.getDefaultAgentSessionId(),
              ...tokenUsageExtra,
            }
          : {
              sessionId: result.agentSessionId,
              ...tokenUsageExtra,
            },
        agent: options?.agent,
      });

      return {
        ...recorded,
        agentSessionId: useDefaultSession
          ? this.params.sessionManager.getDefaultAgentSessionId()
          : result.agentSessionId,
        ...(tokenUsageExtra?.tokenUsage ? { tokenUsage: tokenUsageExtra.tokenUsage } : {}),
        defaultAgentSelection: toDownstreamAgentSelection(agentConfig),
      };
    } catch (error) {
      return this.params.recorder.fail(started, error, options?.agent);
    }
  }

}

function formatAgentLabel(agent?: DownstreamAgentSelection): string {
  if (!agent) {
    return "";
  }

  return agent.model ? ` [${agent.provider}:${agent.model}]` : ` [${agent.provider}]`;
}
