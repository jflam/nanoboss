import { DefaultConversationSession } from "../agent/default-session.ts";
import { normalizeAgentTokenUsage } from "../agent/token-usage.ts";
import type { AgentRuntimeCapabilityMode } from "../agent/runtime-capability.ts";
import { resolveDownstreamAgentConfig } from "./config.ts";
import type { PreparedDefaultPrompt } from "./context-shared.ts";
import type {
  AgentSessionMode,
  CallAgentTransport,
  DownstreamAgentConfig,
  DownstreamAgentSelection,
  ProcedureSessionMode,
} from "./types.ts";
import type { RunTimingTrace } from "./timing-trace.ts";

export interface ProcedureInvocationBinding {
  defaultConversation?: DefaultConversationSession;
  getDefaultAgentConfig: () => DownstreamAgentConfig;
  setDefaultAgentSelection: (selection: DownstreamAgentSelection) => DownstreamAgentConfig;
  prepareDefaultPrompt?: (prompt: string) => PreparedDefaultPrompt;
  runtimeCapabilityMode: AgentRuntimeCapabilityMode;
}

interface ContextSessionApiImplParams {
  cwd: string;
  defaultConversation: () => DefaultConversationSession | undefined;
  getDefaultAgentConfig: () => () => DownstreamAgentConfig;
  setDefaultAgentSelection: () => (selection: DownstreamAgentSelection) => DownstreamAgentConfig;
  prepareDefaultPrompt: () => ((prompt: string) => PreparedDefaultPrompt) | undefined;
  rootDefaultConversation: () => DefaultConversationSession | undefined;
  rootGetDefaultAgentConfig: () => () => DownstreamAgentConfig;
  rootSetDefaultAgentSelection: () => (selection: DownstreamAgentSelection) => DownstreamAgentConfig;
  rootPrepareDefaultPrompt: () => ((prompt: string) => PreparedDefaultPrompt) | undefined;
  runtimeCapabilityMode: () => AgentRuntimeCapabilityMode;
}

export class ContextSessionApiImpl {
  constructor(private readonly params: ContextSessionApiImplParams) {}

  getDefaultAgentConfig(): DownstreamAgentConfig {
    return this.params.getDefaultAgentConfig()();
  }

  setDefaultAgentSelection(selection: DownstreamAgentSelection): DownstreamAgentConfig {
    return this.params.setDefaultAgentSelection()(selection);
  }

  async getDefaultAgentTokenSnapshot() {
    return await this.params.defaultConversation()?.getCurrentTokenSnapshot();
  }

  async getDefaultAgentTokenUsage() {
    return normalizeAgentTokenUsage(
      await this.params.defaultConversation()?.getCurrentTokenSnapshot(),
      this.getDefaultAgentConfig(),
    );
  }

  createCallAgentTransport(
    sessionMode: AgentSessionMode,
    timingTrace?: RunTimingTrace,
  ): CallAgentTransport | undefined {
    const defaultConversation = this.params.defaultConversation();
    if (sessionMode !== "default" || !defaultConversation) {
      return undefined;
    }

    return {
      invoke: async (prompt, options) => {
        const preparedPrompt = this.params.prepareDefaultPrompt()?.(prompt) ?? { prompt };

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
      return {
        defaultConversation: this.params.rootDefaultConversation(),
        getDefaultAgentConfig: this.params.rootGetDefaultAgentConfig(),
        setDefaultAgentSelection: this.params.rootSetDefaultAgentSelection(),
        prepareDefaultPrompt: this.params.rootPrepareDefaultPrompt(),
        runtimeCapabilityMode: this.params.runtimeCapabilityMode(),
      };
    }

    if (sessionMode === "fresh") {
      let defaultAgentConfig = cloneDownstreamAgentConfig(this.getDefaultAgentConfig());
      const defaultConversation = new DefaultConversationSession({
        config: defaultAgentConfig,
        runtimeCapabilityMode: this.params.runtimeCapabilityMode(),
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
        prepareDefaultPrompt: this.params.prepareDefaultPrompt(),
        runtimeCapabilityMode: this.params.runtimeCapabilityMode(),
      };
    }

    return {
      defaultConversation: this.params.defaultConversation(),
      getDefaultAgentConfig: this.params.getDefaultAgentConfig(),
      setDefaultAgentSelection: this.params.setDefaultAgentSelection(),
      prepareDefaultPrompt: this.params.prepareDefaultPrompt(),
      runtimeCapabilityMode: this.params.runtimeCapabilityMode(),
    };
  }

  getDefaultConversationSessionId(): string | undefined {
    return this.params.defaultConversation()?.currentSessionId;
  }

  hasDefaultConversation(): boolean {
    return this.params.defaultConversation() !== undefined;
  }

  getRuntimeCapabilityMode(): AgentRuntimeCapabilityMode {
    return this.params.runtimeCapabilityMode();
  }
}

function cloneDownstreamAgentConfig(config: DownstreamAgentConfig): DownstreamAgentConfig {
  return {
    ...config,
    args: [...config.args],
    env: config.env ? { ...config.env } : undefined,
  };
}
