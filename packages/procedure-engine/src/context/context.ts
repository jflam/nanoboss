import type { SessionStore } from "@nanoboss/store";
import type { CreateAgentSession } from "@nanoboss/agent-acp";
import { AgentInvocationApiImpl } from "./agent-api.ts";
import { AgentRunRecorder } from "./agent-run-recorder.ts";
import { type RuntimeBindings, type SessionUpdateEmitter } from "./shared.ts";
import { ProcedureInvocationApiImpl, type ChildContextBindingParams } from "./procedure-api.ts";
import { ContextSessionApiImpl } from "./session-api.ts";
import { CommandState } from "./state-api.ts";
import type {
  AgentInvocationApi,
  PromptInput,
  ProcedureApi,
  ProcedurePromptInput,
  ProcedureInvocationApi,
  ProcedureRegistryLike,
  SessionApi,
  StateApi,
  UiApi,
} from "@nanoboss/procedure-sdk";
import { throwIfCancelled } from "@nanoboss/procedure-sdk";

import type { RunLogger } from "../logger.ts";
import { normalizeProcedurePromptInput } from "../prompt.ts";
import type { RunTimingTrace } from "@nanoboss/app-support";
import { UiApiImpl } from "./ui-api.ts";

type ActiveRun = ReturnType<SessionStore["startRun"]>;

interface CommandContextParams {
  cwd: string;
  sessionId?: string;
  logger: RunLogger;
  registry: ProcedureRegistryLike;
  procedureName: string;
  spanId: string;
  emitter: SessionUpdateEmitter;
  store: SessionStore;
  run: ActiveRun;
  promptInput?: string | PromptInput;
  signal?: AbortSignal;
  softStopSignal?: AbortSignal;
  current: RuntimeBindings;
  root: RuntimeBindings;
  isAutoApproveEnabled?: () => boolean;
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
  private readonly run: ActiveRun;
  private readonly rootBindings: RuntimeBindings;
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
    this.run = params.run;
    this.promptInput = normalizeProcedurePromptInput(
      params.promptInput ?? params.run.input,
    );
    this.rootBindings = params.root;
    this.createAgentSessionValue = params.createAgentSession;
    this.assertCanStartBoundaryValue = params.assertCanStartBoundary;
    this.timingTrace = params.timingTrace;
    this.state = new CommandState(
      this.store,
      this.cwd,
      this.run.run.runId,
      () => this.assertCanStartBoundary(),
    );

    const contextSessionApi = new ContextSessionApiImpl({
      cwd: this.cwd,
      current: params.current,
      root: this.rootBindings,
      createAgentSession: this.createAgentSessionValue,
      isAutoApproveEnabled: params.isAutoApproveEnabled,
      assertNotCancelled: () => this.assertCanStartBoundary(),
    });
    this.session = contextSessionApi;

    const recorder = new AgentRunRecorder({
      logger: this.logger,
      store: this.store,
      emitter: this.emitter,
      procedureName: params.procedureName,
      spanId: params.spanId,
      run: this.run,
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
      run: this.run,
      createChildContext: (binding) => this.createChildContext(binding),
    });
    this.ui = new UiApiImpl(
      this.store,
      this.run,
      this.logger,
      params.spanId,
      params.procedureName,
      this.emitter,
      () => this.assertCanStartBoundary(),
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
      run: binding.run,
      promptInput: binding.promptInput,
      signal: this.signal,
      softStopSignal: this.softStopSignal,
      current: binding,
      root: this.rootBindings,
      isAutoApproveEnabled: this.session.isAutoApproveEnabled?.bind(this.session),
      createAgentSession: this.createAgentSessionValue,
      assertCanStartBoundary: this.assertCanStartBoundaryValue,
      timingTrace: this.timingTrace,
    });
  }

  private assertCanStartBoundary(): void {
    this.assertCanStartBoundaryValue?.();
    throwIfCancelled({
      signal: this.signal,
      softStopSignal: this.softStopSignal,
    });
  }
}
