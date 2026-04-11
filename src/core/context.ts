import { DefaultConversationSession } from "../agent/default-session.ts";
import type { AgentRuntimeCapabilityMode } from "../agent/runtime-capability.ts";
import type { SessionStore } from "../session/index.ts";
import { RunCancelledError, defaultCancellationMessage } from "./cancellation.ts";
import { resolveDownstreamAgentConfig } from "./config.ts";
import { AgentInvocationApiImpl, AgentRunRecorder } from "./context-agent.ts";
import { type PreparedDefaultPrompt, type SessionUpdateEmitter } from "./context-shared.ts";
import { ProcedureInvocationApiImpl, type ChildContextBindingParams } from "./context-procedures.ts";
import { ContextSessionApiImpl } from "./context-session.ts";
import { CommandRefs, CommandSession } from "./context-state.ts";
import { type UiApi } from "./ui-api.ts";
import { UiApiImpl } from "./ui-emitter.ts";
import type { RunLogger } from "./logger.ts";
import type { RunTimingTrace } from "./timing-trace.ts";
import type {
  CommandCallAgentOptions,
  CommandCallProcedureOptions,
  CommandContext,
  DownstreamAgentConfig,
  DownstreamAgentSelection,
  KernelValue,
  ProcedureRegistryLike,
  RefsApi,
  RunResult,
  SessionApi,
  TypeDescriptor,
} from "./types.ts";

type ActiveCell = ReturnType<SessionStore["startCell"]>;

export type { PreparedDefaultPrompt, SessionUpdateEmitter } from "./context-shared.ts";

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
  softStopSignal?: AbortSignal;
  defaultConversation?: DefaultConversationSession;
  getDefaultAgentConfig?: () => DownstreamAgentConfig;
  setDefaultAgentSelection?: (selection: DownstreamAgentSelection) => DownstreamAgentConfig;
  prepareDefaultPrompt?: (prompt: string) => PreparedDefaultPrompt;
  rootDefaultConversation?: DefaultConversationSession;
  rootGetDefaultAgentConfig?: () => DownstreamAgentConfig;
  rootSetDefaultAgentSelection?: (selection: DownstreamAgentSelection) => DownstreamAgentConfig;
  rootPrepareDefaultPrompt?: (prompt: string) => PreparedDefaultPrompt;
  assertCanStartBoundary?: () => void;
  timingTrace?: RunTimingTrace;
  agentRuntimeCapabilityMode?: AgentRuntimeCapabilityMode;
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
  private readonly softStopSignal?: AbortSignal;
  private readonly store: SessionStore;
  private readonly cell: ActiveCell;
  private readonly defaultConversation?: DefaultConversationSession;
  private readonly getDefaultAgentConfigValue: () => DownstreamAgentConfig;
  private readonly setDefaultAgentSelectionValue: (selection: DownstreamAgentSelection) => DownstreamAgentConfig;
  private readonly prepareDefaultPromptValue?: (prompt: string) => PreparedDefaultPrompt;
  private readonly rootDefaultConversation?: DefaultConversationSession;
  private readonly rootGetDefaultAgentConfigValue: () => DownstreamAgentConfig;
  private readonly rootSetDefaultAgentSelectionValue: (selection: DownstreamAgentSelection) => DownstreamAgentConfig;
  private readonly rootPrepareDefaultPromptValue?: (prompt: string) => PreparedDefaultPrompt;
  private readonly assertCanStartBoundaryValue?: () => void;
  private readonly timingTrace?: RunTimingTrace;
  private readonly agentRuntimeCapabilityMode: AgentRuntimeCapabilityMode;

  private readonly contextSessionApi: ContextSessionApiImpl;
  private readonly agentInvocationApi: AgentInvocationApiImpl;
  private readonly procedureInvocationApi: ProcedureInvocationApiImpl;
  private readonly ui: UiApi;

  constructor(params: CommandContextParams) {
    this.cwd = params.cwd;
    this.sessionId = params.sessionId ?? params.store.sessionId;
    this.logger = params.logger;
    this.registry = params.registry;
    this.procedureName = params.procedureName;
    this.spanId = params.spanId;
    this.emitter = params.emitter;
    this.signal = params.signal;
    this.softStopSignal = params.softStopSignal;
    this.store = params.store;
    this.cell = params.cell;
    this.defaultConversation = params.defaultConversation;
    this.getDefaultAgentConfigValue = params.getDefaultAgentConfig
      ?? (() => resolveDownstreamAgentConfig(this.cwd));
    this.setDefaultAgentSelectionValue = params.setDefaultAgentSelection
      ?? ((selection) => resolveDownstreamAgentConfig(this.cwd, selection));
    this.prepareDefaultPromptValue = params.prepareDefaultPrompt;
    this.rootDefaultConversation = params.rootDefaultConversation ?? this.defaultConversation;
    this.rootGetDefaultAgentConfigValue = params.rootGetDefaultAgentConfig ?? this.getDefaultAgentConfigValue;
    this.rootSetDefaultAgentSelectionValue = params.rootSetDefaultAgentSelection ?? this.setDefaultAgentSelectionValue;
    this.rootPrepareDefaultPromptValue = params.rootPrepareDefaultPrompt ?? this.prepareDefaultPromptValue;
    this.assertCanStartBoundaryValue = params.assertCanStartBoundary;
    this.timingTrace = params.timingTrace;
    this.agentRuntimeCapabilityMode = params.agentRuntimeCapabilityMode ?? "mcp";
    this.refs = new CommandRefs(this.store, this.cwd);
    this.session = new CommandSession(this.store, this.cell.cell.cellId);

    this.contextSessionApi = new ContextSessionApiImpl({
      cwd: this.cwd,
      defaultConversation: () => this.defaultConversation,
      getDefaultAgentConfig: () => this.getDefaultAgentConfigValue,
      setDefaultAgentSelection: () => this.setDefaultAgentSelectionValue,
      prepareDefaultPrompt: () => this.prepareDefaultPromptValue,
      rootDefaultConversation: () => this.rootDefaultConversation,
      rootGetDefaultAgentConfig: () => this.rootGetDefaultAgentConfigValue,
      rootSetDefaultAgentSelection: () => this.rootSetDefaultAgentSelectionValue,
      rootPrepareDefaultPrompt: () => this.rootPrepareDefaultPromptValue,
      runtimeCapabilityMode: () => this.agentRuntimeCapabilityMode,
    });

    const recorder = new AgentRunRecorder({
      logger: this.logger,
      store: this.store,
      emitter: this.emitter,
      procedureName: this.procedureName,
      spanId: this.spanId,
      cell: this.cell,
      softStopSignal: this.softStopSignal,
      timingTrace: this.timingTrace,
    });
    this.agentInvocationApi = new AgentInvocationApiImpl({
      cwd: this.cwd,
      signal: this.signal,
      softStopSignal: this.softStopSignal,
      store: this.store,
      emitter: this.emitter,
      sessionManager: this.contextSessionApi,
      assertCanStartBoundary: () => this.assertCanStartBoundary(),
      recorder,
      timingTrace: this.timingTrace,
    });
    this.procedureInvocationApi = new ProcedureInvocationApiImpl({
      cwd: this.cwd,
      sessionId: this.sessionId,
      logger: this.logger,
      registry: this.registry,
      emitter: this.emitter,
      store: this.store,
      signal: this.signal,
      softStopSignal: this.softStopSignal,
      sessionManager: this.contextSessionApi,
      assertCanStartBoundary: () => this.assertCanStartBoundary(),
      timingTrace: this.timingTrace,
      spanId: this.spanId,
      cell: this.cell,
      createChildContext: (binding) => this.createChildContext(binding),
    });
    this.ui = new UiApiImpl(
      this.store,
      this.cell,
      this.logger,
      this.spanId,
      this.procedureName,
      this.emitter,
    );
  }

  getDefaultAgentConfig(): DownstreamAgentConfig {
    return this.contextSessionApi.getDefaultAgentConfig();
  }

  setDefaultAgentSelection(selection: DownstreamAgentSelection): DownstreamAgentConfig {
    return this.contextSessionApi.setDefaultAgentSelection(selection);
  }

  async getDefaultAgentTokenSnapshot() {
    return await this.contextSessionApi.getDefaultAgentTokenSnapshot();
  }

  async getDefaultAgentTokenUsage() {
    return await this.contextSessionApi.getDefaultAgentTokenUsage();
  }

  assertNotCancelled(): void {
    this.assertCanStartBoundary();
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
    return await this.agentInvocationApi.callAgent(
      prompt,
      descriptorOrOptions as TypeDescriptor<KernelValue> | CommandCallAgentOptions | undefined,
      maybeOptions,
    ) as RunResult<T> | RunResult<string>;
  }

  async callProcedure<T extends KernelValue = KernelValue>(
    name: string,
    prompt: string,
    options?: CommandCallProcedureOptions,
  ): Promise<RunResult<T>> {
    return await this.procedureInvocationApi.callProcedure<T>(name, prompt, options) as RunResult<T>;
  }

  print(text: string): void {
    this.ui.text(text);
  }

  private createChildContext(binding: ChildContextBindingParams): CommandContextImpl {
    return new CommandContextImpl({
      cwd: this.cwd,
      sessionId: this.sessionId,
      logger: this.logger,
      registry: this.registry,
      procedureName: binding.procedureName,
      spanId: binding.spanId,
      emitter: this.emitter,
      store: this.store,
      cell: binding.cell,
      signal: this.signal,
      softStopSignal: this.softStopSignal,
      defaultConversation: binding.defaultConversation,
      getDefaultAgentConfig: binding.getDefaultAgentConfig,
      setDefaultAgentSelection: binding.setDefaultAgentSelection,
      prepareDefaultPrompt: binding.prepareDefaultPrompt,
      rootDefaultConversation: this.rootDefaultConversation,
      rootGetDefaultAgentConfig: this.rootGetDefaultAgentConfigValue,
      rootSetDefaultAgentSelection: this.rootSetDefaultAgentSelectionValue,
      rootPrepareDefaultPrompt: this.rootPrepareDefaultPromptValue,
      assertCanStartBoundary: this.assertCanStartBoundaryValue,
      timingTrace: this.timingTrace,
      agentRuntimeCapabilityMode: binding.runtimeCapabilityMode,
    });
  }

  private assertCanStartBoundary(): void {
    this.assertCanStartBoundaryValue?.();

    if (this.softStopSignal?.aborted) {
      throw new RunCancelledError(defaultCancellationMessage("soft_stop"), "soft_stop");
    }

    if (this.signal?.aborted) {
      throw new RunCancelledError(defaultCancellationMessage("abort"), "abort");
    }
  }
}
