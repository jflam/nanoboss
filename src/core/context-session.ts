import { DefaultConversationSession } from "../agent/default-session.ts";
import { normalizeAgentTokenUsage } from "../agent/token-usage.ts";
import { resolveDownstreamAgentConfig } from "./config.ts";
import type { PreparedDefaultPrompt } from "./context-shared.ts";
import type {
  AgentSessionMode,
  CallAgentTransport,
  DownstreamAgentConfig,
  DownstreamAgentSelection,
  ProcedureSessionMode,
  SessionApi,
} from "./types.ts";
import type { RunTimingTrace } from "./timing-trace.ts";

interface SessionBindingSource {
  defaultConversation?: DefaultConversationSession;
  getDefaultAgentConfig: () => DownstreamAgentConfig;
  setDefaultAgentSelection: (selection: DownstreamAgentSelection) => DownstreamAgentConfig;
  prepareDefaultPrompt?: (prompt: string) => PreparedDefaultPrompt;
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
    return await this.params.current.defaultConversation?.getCurrentTokenSnapshot();
  }

  async getDefaultAgentTokenUsage() {
    return normalizeAgentTokenUsage(
      await this.params.current.defaultConversation?.getCurrentTokenSnapshot(),
      this.getDefaultAgentConfig(),
    );
  }

  createCallAgentTransport(
    sessionMode: AgentSessionMode,
    timingTrace?: RunTimingTrace,
  ): CallAgentTransport | undefined {
    const defaultConversation = this.params.current.defaultConversation;
    if (sessionMode !== "default" || !defaultConversation) {
      return undefined;
    }

    return {
      invoke: async (prompt, options) => {
        const preparedPrompt = this.params.current.prepareDefaultPrompt?.(prompt) ?? { prompt };

        const result = await defaultConversation.prompt(preparedPrompt.prompt, {
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
      const defaultConversation = new DefaultConversationSession({
        config: defaultAgentConfig,
      });

      return {
        defaultConversation,
        getDefaultAgentConfig: () => defaultAgentConfig,
        setDefaultAgentSelection: (selection) => {
          const nextConfig = resolveDownstreamAgentConfig(this.params.cwd, selection);
          defaultAgentConfig = nextConfig;
          defaultConversation.updateConfig(nextConfig);
          return nextConfig;
        },
        prepareDefaultPrompt: this.params.current.prepareDefaultPrompt,
      };
    }

    return toProcedureInvocationBinding(this.params.current);
  }

  getDefaultConversationSessionId(): string | undefined {
    return this.params.current.defaultConversation?.currentSessionId;
  }

  hasDefaultConversation(): boolean {
    return this.params.current.defaultConversation !== undefined;
  }
}

function toProcedureInvocationBinding(binding: SessionBindingSource): ProcedureInvocationBinding {
  return {
    defaultConversation: binding.defaultConversation,
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
