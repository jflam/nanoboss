import { DefaultConversationSession } from "../agent/default-session.ts";
import { normalizeAgentTokenUsage } from "../agent/token-usage.ts";
import { createTextPromptInput } from "./prompt.ts";
import { resolveDownstreamAgentConfig } from "./config.ts";
import type { PreparedDefaultPrompt } from "./context-shared.ts";
import type {
  AgentSession,
  AgentSessionMode,
  CallAgentTransport,
  DownstreamAgentConfig,
  DownstreamAgentSelection,
  PromptInput,
  ProcedureSessionMode,
  SessionApi,
} from "./types.ts";
import type { RunTimingTrace } from "./timing-trace.ts";

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
      const agentSession = new DefaultConversationSession({
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
