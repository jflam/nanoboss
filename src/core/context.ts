import type { SessionStore } from "../session/index.ts";
import type { CreateAgentSession } from "../agent/acp-session.ts";
import { RunCancelledError, defaultCancellationMessage } from "./cancellation.ts";
import { resolveDownstreamAgentConfig } from "./config.ts";
import { AgentInvocationApiImpl, AgentRunRecorder } from "./context-agent.ts";
import { type PreparedDefaultPrompt, type SessionUpdateEmitter } from "./context-shared.ts";
import { ProcedureInvocationApiImpl, type ChildContextBindingParams } from "./context-procedures.ts";
import { ContextSessionApiImpl } from "./context-session.ts";
import { CommandState } from "./context-state.ts";
import { type UiApi } from "./ui-api.ts";
import { UiApiImpl } from "./ui-emitter.ts";
import type { RunLogger } from "./logger.ts";
import { normalizeProcedurePromptInput } from "./prompt.ts";
import type { RunTimingTrace } from "./timing-trace.ts";
import type {
  AgentSession,
  AgentInvocationApi,
  ProcedureApi,
  ProcedurePromptInput,
  DownstreamAgentConfig,
  DownstreamAgentSelection,
  PromptInput,
  ProcedureInvocationApi,
  ProcedureRegistryLike,
  SessionApi,
  StateApi,
} from "./types.ts";

type ActiveCell = ReturnType<SessionStore["startCell"]>;

export type { PreparedDefaultPrompt, ProcedureUiEvent, SessionUpdateEmitter } from "./context-shared.ts";

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
  promptInput?: string | PromptInput;
  signal?: AbortSignal;
  softStopSignal?: AbortSignal;
  agentSession?: AgentSession;
  getDefaultAgentConfig?: () => DownstreamAgentConfig;
  setDefaultAgentSelection?: (selection: DownstreamAgentSelection) => DownstreamAgentConfig;
  prepareDefaultPrompt?: (promptInput: PromptInput) => PreparedDefaultPrompt;
  rootAgentSession?: AgentSession;
  rootGetDefaultAgentConfig?: () => DownstreamAgentConfig;
  rootSetDefaultAgentSelection?: (selection: DownstreamAgentSelection) => DownstreamAgentConfig;
  rootPrepareDefaultPrompt?: (promptInput: PromptInput) => PreparedDefaultPrompt;
  createAgentSession?: CreateAgentSession;
  assertCanStartBoundary?: () => void;
  timingTrace?: RunTimingTrace;
}

export class CommandContextImpl implements ProcedureApi {
  readonly cwd: string;
  readonly sessionId: string;
  readonly promptInput: ProcedurePromptInput;
  readonly agent: AgentInvocationApi;
  readonly state: StateApi;
  readonly ui: UiApi;
  readonly procedures: ProcedureInvocationApi;
  readonly session: SessionApi;

  private readonly logger: RunLogger;
  private readonly registry: ProcedureRegistryLike;
  private readonly emitter: SessionUpdateEmitter;
  private readonly signal?: AbortSignal;
  private readonly softStopSignal?: AbortSignal;
  private readonly store: SessionStore;
  private readonly cell: ActiveCell;
  private readonly rootAgentSession?: AgentSession;
  private readonly rootGetDefaultAgentConfigValue: () => DownstreamAgentConfig;
  private readonly rootSetDefaultAgentSelectionValue: (selection: DownstreamAgentSelection) => DownstreamAgentConfig;
  private readonly rootPrepareDefaultPromptValue?: (promptInput: PromptInput) => PreparedDefaultPrompt;
  private readonly createAgentSessionValue?: CreateAgentSession;
  private readonly assertCanStartBoundaryValue?: () => void;
  private readonly timingTrace?: RunTimingTrace;

  constructor(params: CommandContextParams) {
    this.cwd = params.cwd;
    this.sessionId = params.sessionId ?? params.store.sessionId;
    this.logger = params.logger;
    this.registry = params.registry;
    this.emitter = params.emitter;
    this.signal = params.signal;
    this.softStopSignal = params.softStopSignal;
    this.store = params.store;
    this.cell = params.cell;
    this.promptInput = normalizeProcedurePromptInput(
      params.promptInput ?? params.cell.input,
    );
    const getDefaultAgentConfig = params.getDefaultAgentConfig
      ?? (() => resolveDownstreamAgentConfig(this.cwd));
    const setDefaultAgentSelection = params.setDefaultAgentSelection
      ?? ((selection) => resolveDownstreamAgentConfig(this.cwd, selection));
    const prepareDefaultPrompt = params.prepareDefaultPrompt;
    const agentSession = params.agentSession;
    this.rootAgentSession = params.rootAgentSession ?? agentSession;
    this.rootGetDefaultAgentConfigValue = params.rootGetDefaultAgentConfig ?? getDefaultAgentConfig;
    this.rootSetDefaultAgentSelectionValue = params.rootSetDefaultAgentSelection ?? setDefaultAgentSelection;
    this.rootPrepareDefaultPromptValue = params.rootPrepareDefaultPrompt ?? prepareDefaultPrompt;
    this.createAgentSessionValue = params.createAgentSession;
    this.assertCanStartBoundaryValue = params.assertCanStartBoundary;
    this.timingTrace = params.timingTrace;
    this.state = new CommandState(this.store, this.cwd, this.cell.cell.cellId);

    const contextSessionApi = new ContextSessionApiImpl({
      cwd: this.cwd,
      current: {
        agentSession,
        getDefaultAgentConfig,
        setDefaultAgentSelection,
        prepareDefaultPrompt,
      },
      root: {
        agentSession: this.rootAgentSession,
        getDefaultAgentConfig: this.rootGetDefaultAgentConfigValue,
        setDefaultAgentSelection: this.rootSetDefaultAgentSelectionValue,
        prepareDefaultPrompt: this.rootPrepareDefaultPromptValue,
      },
      createAgentSession: this.createAgentSessionValue,
    });
    this.session = contextSessionApi;

    const recorder = new AgentRunRecorder({
      logger: this.logger,
      store: this.store,
      emitter: this.emitter,
      procedureName: params.procedureName,
      spanId: params.spanId,
      cell: this.cell,
      softStopSignal: this.softStopSignal,
      timingTrace: this.timingTrace,
    });
    this.agent = new AgentInvocationApiImpl({
      cwd: this.cwd,
      signal: this.signal,
      softStopSignal: this.softStopSignal,
      store: this.store,
      emitter: this.emitter,
      sessionManager: contextSessionApi,
      assertCanStartBoundary: () => this.assertCanStartBoundary(),
      recorder,
      timingTrace: this.timingTrace,
    });

    this.procedures = new ProcedureInvocationApiImpl({
      logger: this.logger,
      registry: this.registry,
      store: this.store,
      sessionManager: contextSessionApi,
      assertCanStartBoundary: () => this.assertCanStartBoundary(),
      spanId: params.spanId,
      cell: this.cell,
      createChildContext: (binding) => this.createChildContext(binding),
    });
    this.ui = new UiApiImpl(
      this.store,
      this.cell,
      this.logger,
      params.spanId,
      params.procedureName,
      this.emitter,
    );
  }

  assertNotCancelled(): void {
    this.assertCanStartBoundary();
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
      promptInput: binding.promptInput,
      signal: this.signal,
      softStopSignal: this.softStopSignal,
      agentSession: binding.agentSession,
      getDefaultAgentConfig: binding.getDefaultAgentConfig,
      setDefaultAgentSelection: binding.setDefaultAgentSelection,
      prepareDefaultPrompt: binding.prepareDefaultPrompt,
      rootAgentSession: this.rootAgentSession,
      rootGetDefaultAgentConfig: this.rootGetDefaultAgentConfigValue,
      rootSetDefaultAgentSelection: this.rootSetDefaultAgentSelectionValue,
      rootPrepareDefaultPrompt: this.rootPrepareDefaultPromptValue,
      createAgentSession: this.createAgentSessionValue,
      assertCanStartBoundary: this.assertCanStartBoundaryValue,
      timingTrace: this.timingTrace,
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
