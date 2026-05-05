import type * as acp from "@agentclientprotocol/sdk";
import {
  createTextPromptInput,
  hasPromptInputImages,
  promptInputDisplayText,
} from "@nanoboss/procedure-sdk";

import { collectFinalTextSessionOutput, parseAssistantNoticeText } from "./updates.ts";
import { RunCancelledError, defaultCancellationMessage } from "./cancellation.ts";
import { waitForSettledUpdateQueue } from "./prompt-settle.ts";
import {
  promptInputToAcpBlocks,
  summarizePromptInputForAcpLog,
} from "./prompt.ts";
import {
  closeAcpConnection,
  openAcpConnection,
  type OpenAcpConnection,
} from "./runtime.ts";
import { buildAgentRuntimeSessionRuntime } from "./runtime-capability.ts";
import { collectTokenSnapshot, enrichToolCallUpdateWithTokenUsage } from "./token-metrics.ts";
import { appendTimingTraceEvent, type RunTimingTrace } from "@nanoboss/app-support";
import { applyConfiguredSessionOptions } from "./session-config-options.ts";
import { sameAgentConfig } from "./agent-config-equality.ts";
import type {
  AgentSession,
  AgentSessionPromptOptions,
  AgentSessionPromptResult,
  AgentTokenSnapshot,
  CallAgentOptions,
  DownstreamAgentConfig,
  PromptInput,
} from "./types.ts";
import { parseProcedureUiMarker } from "./ui-marker.ts";

interface PromptCollector {
  raw: string;
  updates: acp.SessionUpdate[];
  onUpdate?: CallAgentOptions["onUpdate"];
  lastTask: Promise<void>;
  firstUpdateRecorded: boolean;
  timingTrace?: RunTimingTrace;
}

interface AcpAgentSessionParams {
  config: DownstreamAgentConfig;
  persistedSessionId?: acp.SessionId;
}

export type CreateAgentSessionParams = AcpAgentSessionParams;
export type CreateAgentSession = (params: CreateAgentSessionParams) => AgentSession;

export const createAgentSession: CreateAgentSession = (params) => new AcpAgentSession(params);

class AcpAgentSession implements AgentSession {
  private persistedSessionId?: acp.SessionId;
  private liveSession?: PersistentAcpSession;
  private config: DownstreamAgentConfig;
  private lastTokenSnapshot?: AgentTokenSnapshot;
  private sessionPromise?: Promise<PersistentAcpSession>;
  private sessionGeneration = 0;

  constructor(params: AcpAgentSessionParams) {
    this.config = params.config;
    this.persistedSessionId = params.persistedSessionId;
  }

  get sessionId(): string | undefined {
    return this.persistedSessionId;
  }

  get currentTokenSnapshot(): AgentTokenSnapshot | undefined {
    return this.liveSession?.currentTokenSnapshot ?? this.lastTokenSnapshot;
  }

  async getCurrentTokenSnapshot(): Promise<AgentTokenSnapshot | undefined> {
    if (this.liveSession?.isAlive()) {
      this.lastTokenSnapshot = await this.liveSession.refreshTokenSnapshot() ?? this.lastTokenSnapshot;
    }

    return this.liveSession?.currentTokenSnapshot ?? this.lastTokenSnapshot;
  }

  async warm(timingTrace?: RunTimingTrace): Promise<void> {
    try {
      await this.ensureSession(timingTrace);
    } catch {
      // Warmup is a latency optimization; prompt() will retry on demand.
    }
  }

  async prompt(
    prompt: string | PromptInput,
    options: AgentSessionPromptOptions = {},
  ): Promise<AgentSessionPromptResult> {
    const startedAt = Date.now();
    appendTimingTraceEvent(options.timingTrace, "default_session", "prompt_started");
    const session = await this.ensureSession(options.timingTrace);
    const promptInput = typeof prompt === "string" ? createTextPromptInput(prompt) : prompt;

    try {
      const result = await session.prompt(promptInput, options);
      this.persistedSessionId = session.sessionId;
      this.lastTokenSnapshot = result.tokenSnapshot ?? this.lastTokenSnapshot;
      appendTimingTraceEvent(options.timingTrace, "default_session", "prompt_completed", {
        sessionId: session.sessionId,
        durationMs: Date.now() - startedAt,
        updateCount: result.updates.length,
      });
      return {
        ...result,
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      appendTimingTraceEvent(options.timingTrace, "default_session", "prompt_failed", {
        sessionId: session.sessionId,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      if (!session.isAlive()) {
        session.close();
        if (this.liveSession === session) {
          this.liveSession = undefined;
        }
      }
      throw error;
    }
  }

  updateConfig(config: DownstreamAgentConfig): void {
    if (sameAgentConfig(this.config, config)) {
      this.config = config;
      return;
    }

    this.close();
    this.persistedSessionId = undefined;
    this.lastTokenSnapshot = undefined;
    this.config = config;
  }

  close(): void {
    this.sessionGeneration += 1;
    this.sessionPromise = undefined;
    this.liveSession?.close();
    this.liveSession = undefined;
  }

  private async ensureSession(timingTrace?: RunTimingTrace): Promise<PersistentAcpSession> {
    const liveSession = this.liveSession;
    if (liveSession?.isAlive()) {
      appendTimingTraceEvent(timingTrace, "default_session", "reused_live_session", {
        sessionId: liveSession.sessionId,
      });
      return liveSession;
    }

    if (liveSession) {
      liveSession.close();
      this.liveSession = undefined;
    }

    if (this.sessionPromise) {
      appendTimingTraceEvent(timingTrace, "default_session", "awaiting_inflight_session");
      return await this.sessionPromise;
    }

    const generation = this.sessionGeneration;
    appendTimingTraceEvent(timingTrace, "default_session", "establish_session_started", {
      persistedSessionId: this.persistedSessionId,
    });

    const pending = this.establishSession(generation, timingTrace);
    this.sessionPromise = pending;
    try {
      return await pending;
    } finally {
      if (this.sessionPromise === pending) {
        this.sessionPromise = undefined;
      }
    }
  }

  private async establishSession(
    generation: number,
    timingTrace?: RunTimingTrace,
  ): Promise<PersistentAcpSession> {
    let session: PersistentAcpSession | undefined;

    if (this.persistedSessionId) {
      appendTimingTraceEvent(timingTrace, "default_session", "load_session_attempt_started", {
        sessionId: this.persistedSessionId,
      });
      session = await PersistentAcpSession.load(
        this.config,
        this.persistedSessionId,
        timingTrace,
      );
      appendTimingTraceEvent(timingTrace, "default_session", "load_session_attempt_completed", {
        sessionId: this.persistedSessionId,
        loaded: session !== undefined,
      });
    }

    if (!session) {
      appendTimingTraceEvent(timingTrace, "default_session", "create_fresh_session_started");
      session = await PersistentAcpSession.createFresh(this.config, timingTrace);
      appendTimingTraceEvent(timingTrace, "default_session", "create_fresh_session_completed", {
        sessionId: session.sessionId,
      });
    }

    if (generation !== this.sessionGeneration) {
      session.close();
      throw new Error("Discarded stale default session establishment.");
    }

    this.liveSession = session;
    this.persistedSessionId = session.sessionId;
    appendTimingTraceEvent(timingTrace, "default_session", "session_ready", {
      sessionId: session.sessionId,
    });
    return session;
  }
}

class PersistentAcpSession {
  private activeCollector?: PromptCollector;
  private closed = false;
  private tokenSnapshot?: AgentTokenSnapshot;
  private updateQueue: Promise<void> = Promise.resolve();

  private constructor(
    private readonly state: OpenAcpConnection,
    private readonly config: DownstreamAgentConfig,
    readonly sessionId: acp.SessionId,
  ) {
    this.state.setSessionUpdateHandler((params) => this.handleSessionUpdate(params));
  }

  static async createFresh(
    config: DownstreamAgentConfig,
    timingTrace?: RunTimingTrace,
  ): Promise<PersistentAcpSession> {
    appendTimingTraceEvent(timingTrace, "default_session", "acp_connection_open_started");
    const state = await openAcpConnection(config);
    appendTimingTraceEvent(timingTrace, "default_session", "acp_connection_open_completed", {
      childPid: state.child.pid,
      hasLoadSession: state.capabilities?.loadSession === true,
    });

    try {
      appendTimingTraceEvent(timingTrace, "default_session", "new_session_rpc_started");
      const session = await state.connection.newSession({
        cwd: state.cwd,
        ...buildAgentRuntimeSessionRuntime(),
      });
      appendTimingTraceEvent(timingTrace, "default_session", "new_session_rpc_completed", {
        sessionId: session.sessionId,
      });
      const runtime = new PersistentAcpSession(state, config, session.sessionId);
      await applyConfiguredSessionOptions(state.connection, session.sessionId, config, timingTrace);
      return runtime;
    } catch (error) {
      closeAcpConnection(state);
      throw error;
    }
  }

  static async load(
    config: DownstreamAgentConfig,
    sessionId: acp.SessionId,
    timingTrace?: RunTimingTrace,
  ): Promise<PersistentAcpSession | undefined> {
    appendTimingTraceEvent(timingTrace, "default_session", "acp_connection_open_started");
    const state = await openAcpConnection(config);
    appendTimingTraceEvent(timingTrace, "default_session", "acp_connection_open_completed", {
      childPid: state.child.pid,
      hasLoadSession: state.capabilities?.loadSession === true,
    });

    try {
      if (!state.capabilities?.loadSession) {
        closeAcpConnection(state);
        return undefined;
      }

      appendTimingTraceEvent(timingTrace, "default_session", "load_session_rpc_started", {
        sessionId,
      });
      await state.connection.loadSession({
        cwd: state.cwd,
        ...buildAgentRuntimeSessionRuntime(),
        sessionId,
      });
      appendTimingTraceEvent(timingTrace, "default_session", "load_session_rpc_completed", {
        sessionId,
      });

      const runtime = new PersistentAcpSession(state, config, sessionId);
      await applyConfiguredSessionOptions(state.connection, sessionId, config, timingTrace);
      return runtime;
    } catch {
      closeAcpConnection(state);
      return undefined;
    }
  }

  get currentTokenSnapshot(): AgentTokenSnapshot | undefined {
    return this.tokenSnapshot;
  }

  async refreshTokenSnapshot(): Promise<AgentTokenSnapshot | undefined> {
    this.tokenSnapshot = await collectTokenSnapshot({
      childPid: this.state.child.pid,
      config: this.config,
      sessionId: this.sessionId,
      updates: [],
    }) ?? this.tokenSnapshot;

    return this.tokenSnapshot;
  }

  isAlive(): boolean {
    return !this.closed && this.state.child.exitCode === null && !this.state.connection.signal.aborted;
  }

  async prompt(
    prompt: PromptInput,
    options: AgentSessionPromptOptions = {},
  ): Promise<{ raw: string; logFile?: string; updates: acp.SessionUpdate[]; tokenSnapshot?: AgentTokenSnapshot }> {
    if (!this.isAlive()) {
      throw new Error("Default ACP session is not available");
    }

    if (this.activeCollector) {
      throw new Error("Default ACP session already has an active prompt.");
    }

    if (options.softStopSignal?.aborted) {
      throw new RunCancelledError(defaultCancellationMessage("soft_stop"), "soft_stop");
    }

    if (options.signal?.aborted) {
      this.close();
      throw new RunCancelledError(defaultCancellationMessage("abort"), "abort");
    }

    if (hasPromptInputImages(prompt) && this.state.capabilities?.promptCapabilities?.image !== true) {
      throw new Error("The configured downstream agent does not advertise ACP image prompt support.");
    }

    const collector: PromptCollector = {
      raw: "",
      updates: [],
      onUpdate: options.onUpdate,
      lastTask: Promise.resolve(),
      firstUpdateRecorded: false,
      timingTrace: options.timingTrace,
    };
    this.activeCollector = collector;

    const softStopListener = () => {
      void this.state.connection.cancel({ sessionId: this.sessionId }).catch(() => {});
    };

    const abortListener = () => {
      softStopListener();
      this.close();
    };

    options.softStopSignal?.addEventListener("abort", softStopListener);
    options.signal?.addEventListener("abort", abortListener);

    try {
      let promptResponse: acp.PromptResponse;
      try {
        this.state.writeEvent({
          event: "prompt_request",
          sessionId: this.sessionId,
          prompt: summarizePromptInputForAcpLog(prompt),
        });
        appendTimingTraceEvent(options.timingTrace, "default_session", "prompt_rpc_started", {
          sessionId: this.sessionId,
          promptLength: promptInputDisplayText(prompt).length,
        });
        promptResponse = await this.state.connection.prompt({
          sessionId: this.sessionId,
          prompt: promptInputToAcpBlocks(prompt),
        });
        this.state.writeEvent({
          event: "prompt_response",
          sessionId: this.sessionId,
          stopReason: promptResponse.stopReason,
        });
        appendTimingTraceEvent(options.timingTrace, "default_session", "prompt_rpc_completed", {
          sessionId: this.sessionId,
        });
      } catch (error) {
        if (options.softStopSignal?.aborted) {
          throw new RunCancelledError(defaultCancellationMessage("soft_stop"), "soft_stop");
        }
        throw error;
      }

      await waitForSettledUpdateQueue(() => collector.lastTask);
      this.tokenSnapshot = await collectTokenSnapshot({
        childPid: this.state.child.pid,
        config: this.config,
        promptResponse,
        sessionId: this.sessionId,
        updates: collector.updates,
      }) ?? this.tokenSnapshot;
      const finalRaw = collectFinalTextSessionOutput(collector.updates) ?? collector.raw;

      return {
        raw: finalRaw,
        logFile: this.state.transcriptPath,
        updates: [...collector.updates],
        tokenSnapshot: this.tokenSnapshot,
      };
    } finally {
      options.softStopSignal?.removeEventListener("abort", softStopListener);
      options.signal?.removeEventListener("abort", abortListener);
      this.activeCollector = undefined;
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    closeAcpConnection(this.state);
  }

  private async handleSessionUpdate(params: acp.SessionNotification): Promise<void> {
    this.state.writeEvent({
      event: "session_update",
      update: params.update,
    });

    const collector = params.sessionId === this.sessionId
      ? this.activeCollector
      : undefined;
    if (!collector) {
      return;
    }

    const task = this.updateQueue.then(async () => {
      const { update, tokenSnapshot } = await enrichToolCallUpdateWithTokenUsage({
        childPid: this.state.child.pid,
        config: this.config,
        sessionId: this.sessionId,
        update: params.update,
        updates: collector.updates,
      });
      this.tokenSnapshot = tokenSnapshot ?? this.tokenSnapshot;
      collector.updates.push(update);
      if (!collector.firstUpdateRecorded) {
        collector.firstUpdateRecorded = true;
        appendTimingTraceEvent(collector.timingTrace, "default_session", "prompt_first_update", {
          sessionId: this.sessionId,
          updateType: update.sessionUpdate,
        });
      }

      if (
        update.sessionUpdate === "agent_message_chunk" &&
        update.content.type === "text"
      ) {
        if (!parseAssistantNoticeText(update.content.text) && !parseProcedureUiMarker(update.content.text)) {
          collector.raw += update.content.text;
        }
      }

      await collector.onUpdate?.(update);
    });

    collector.lastTask = task;
    this.updateQueue = task.catch(() => {});
    await task;
  }
}
