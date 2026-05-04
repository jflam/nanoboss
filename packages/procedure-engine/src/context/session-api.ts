import {
  createAgentSession,
  normalizeAgentTokenUsage,
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
import type { RunTimingTrace } from "@nanoboss/app-support";
import type { RuntimeBindings } from "./shared.ts";

export interface ProcedureInvocationBinding extends RuntimeBindings {
  dispose?(): void;
}

interface ContextSessionApiImplParams {
  cwd: string;
  current: ProcedureInvocationBinding;
  root: RuntimeBindings;
  createAgentSession?: CreateAgentSession;
  isAutoApproveEnabled?: () => boolean;
  assertNotCancelled?: () => void;
}

export class ContextSessionApiImpl implements SessionApi {
  constructor(private readonly params: ContextSessionApiImplParams) {}

  getDefaultAgentConfig(): DownstreamAgentConfig {
    this.params.assertNotCancelled?.();
    return this.params.current.getDefaultAgentConfig();
  }

  setDefaultAgentSelection(selection: DownstreamAgentSelection): DownstreamAgentConfig {
    this.params.assertNotCancelled?.();
    return this.params.current.setDefaultAgentSelection(selection);
  }

  async getDefaultAgentTokenSnapshot() {
    this.params.assertNotCancelled?.();
    return await this.params.current.agentSession?.getCurrentTokenSnapshot();
  }

  async getDefaultAgentTokenUsage() {
    this.params.assertNotCancelled?.();
    return normalizeAgentTokenUsage(
      await this.params.current.agentSession?.getCurrentTokenSnapshot(),
      this.getDefaultAgentConfig(),
    );
  }

  isAutoApproveEnabled(): boolean {
    this.params.assertNotCancelled?.();
    return this.params.isAutoApproveEnabled?.() === true;
  }

  createCallAgentTransport(
    sessionMode: AgentSessionMode,
    timingTrace?: RunTimingTrace,
  ): CallAgentTransport | undefined {
    this.params.assertNotCancelled?.();
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
        return {
          ...result,
          agentSessionId: agentSession.sessionId,
        };
      },
    };
  }

  resolveProcedureInvocationBinding(sessionMode: ProcedureSessionMode): ProcedureInvocationBinding {
    this.params.assertNotCancelled?.();
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
        dispose: () => {
          agentSession.close();
        },
      };
    }

    return toProcedureInvocationBinding(this.params.current);
  }

  getDefaultAgentSessionId(): string | undefined {
    this.params.assertNotCancelled?.();
    return this.params.current.agentSession?.sessionId;
  }

  hasDefaultAgentSession(): boolean {
    this.params.assertNotCancelled?.();
    return this.params.current.agentSession !== undefined;
  }
}

function toProcedureInvocationBinding(
  binding: RuntimeBindings & { dispose?: () => void },
): ProcedureInvocationBinding {
  return {
    agentSession: binding.agentSession,
    getDefaultAgentConfig: binding.getDefaultAgentConfig,
    setDefaultAgentSelection: binding.setDefaultAgentSelection,
    prepareDefaultPrompt: binding.prepareDefaultPrompt,
    dispose: binding.dispose,
  };
}

function cloneDownstreamAgentConfig(config: DownstreamAgentConfig): DownstreamAgentConfig {
  return {
    ...config,
    args: [...config.args],
    env: config.env ? { ...config.env } : undefined,
  };
}
