import {
  createAgentSession,
  normalizeAgentTokenUsage,
  type AgentSession,
  type CallAgentTransport,
  type CreateAgentSession,
} from "@nanoboss/agent-acp";
import type {
  AgentSessionMode,
  DownstreamAgentConfig,
  DownstreamAgentSelection,
  PromptInput,
  ProcedureSessionMode,
  SessionApi,
} from "@nanoboss/procedure-sdk";
import { createTextPromptInput } from "@nanoboss/procedure-sdk";

import { resolveDownstreamAgentConfig } from "../agent-config.ts";
import type { RunTimingTrace } from "../timing-trace.ts";
import type { PreparedDefaultPrompt } from "./shared.ts";

interface SessionBindingSource {
  agentSession?: AgentSession;
  getDefaultAgentConfig: () => DownstreamAgentConfig;
  setDefaultAgentSelection: (selection: DownstreamAgentSelection) => DownstreamAgentConfig;
  prepareDefaultPrompt?: (promptInput: PromptInput) => PreparedDefaultPrompt;
}

export interface ProcedureInvocationBinding extends SessionBindingSource {}

interface ContextSessionApiImplParams {
  cwd: string;
  current: SessionBindingSource;
  root: SessionBindingSource;
  createAgentSession?: CreateAgentSession;
  isAutoApproveEnabled?: () => boolean;
}

export class ContextSessionApiImpl implements SessionApi {
  constructor(private readonly params: ContextSessionApiImplParams) {}

  getDefaultAgentConfig(): DownstreamAgentConfig {
    return this.params.current.getDefaultAgentConfig();
  }

  setDefaultAgentSelection(selection: DownstreamAgentSelection): DownstreamAgentConfig {
    return this.params.current.setDefaultAgentSelection(selection);
  }

  async getDefaultAgentTokenSnapshot() {
    return await this.params.current.agentSession?.getCurrentTokenSnapshot();
  }

  async getDefaultAgentTokenUsage() {
    return normalizeAgentTokenUsage(
      await this.params.current.agentSession?.getCurrentTokenSnapshot(),
      this.getDefaultAgentConfig(),
    );
  }

  isAutoApproveEnabled(): boolean {
    return this.params.isAutoApproveEnabled?.() === true;
  }

  createCallAgentTransport(
    sessionMode: AgentSessionMode,
    timingTrace?: RunTimingTrace,
  ): CallAgentTransport | undefined {
    const agentSession = this.params.current.agentSession;
    if (sessionMode !== "default" || !agentSession) {
      return undefined;
    }

    return {
      invoke: async (prompt, options) => {
        const promptInput = options.promptInput ?? createTextPromptInput(prompt);
        const preparedPrompt = this.params.current.prepareDefaultPrompt?.(promptInput) ?? { promptInput };
        const result = await agentSession.prompt(preparedPrompt.promptInput, {
          signal: options.signal,
          softStopSignal: options.softStopSignal,
          onUpdate: options.onUpdate,
          timingTrace,
        });

        preparedPrompt.markSubmitted?.();
        return result;
      },
    };
  }

  resolveProcedureInvocationBinding(sessionMode: ProcedureSessionMode): ProcedureInvocationBinding {
    if (sessionMode === "default") {
      return toProcedureInvocationBinding(this.params.root);
    }

    if (sessionMode === "fresh") {
      let defaultAgentConfig = cloneDownstreamAgentConfig(this.getDefaultAgentConfig());
      const agentSession = (this.params.createAgentSession ?? createAgentSession)({
        config: defaultAgentConfig,
      });

      return {
        agentSession,
        getDefaultAgentConfig: () => defaultAgentConfig,
        setDefaultAgentSelection: (selection) => {
          const nextConfig = resolveDownstreamAgentConfig(this.params.cwd, selection);
          defaultAgentConfig = nextConfig;
          agentSession.updateConfig(nextConfig);
          return nextConfig;
        },
        prepareDefaultPrompt: this.params.current.prepareDefaultPrompt,
      };
    }

    return toProcedureInvocationBinding(this.params.current);
  }

  getDefaultAgentSessionId(): string | undefined {
    return this.params.current.agentSession?.sessionId;
  }

  hasDefaultAgentSession(): boolean {
    return this.params.current.agentSession !== undefined;
  }
}

function toProcedureInvocationBinding(binding: SessionBindingSource): ProcedureInvocationBinding {
  return {
    agentSession: binding.agentSession,
    getDefaultAgentConfig: binding.getDefaultAgentConfig,
    setDefaultAgentSelection: binding.setDefaultAgentSelection,
    prepareDefaultPrompt: binding.prepareDefaultPrompt,
  };
}

function cloneDownstreamAgentConfig(config: DownstreamAgentConfig): DownstreamAgentConfig {
  return {
    ...config,
    args: [...config.args],
    env: config.env ? { ...config.env } : undefined,
  };
}
