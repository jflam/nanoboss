import type * as acp from "@agentclientprotocol/sdk";

import { parseAssistantNoticeText } from "./acp-updates.ts";
import {
  applyAcpSessionConfig,
  closeAcpConnection,
  openAcpConnection,
  type OpenAcpConnection,
} from "./acp-runtime.ts";
import { buildGlobalMcpStdioServer } from "../mcp/registration.ts";
import { RunCancelledError, defaultCancellationMessage } from "../core/cancellation.ts";
import { appendTimingTraceEvent, type RunTimingTrace } from "../core/timing-trace.ts";
import { collectTokenSnapshot, enrichToolCallUpdateWithTokenUsage } from "./token-metrics.ts";
import type { AgentTokenSnapshot, CallAgentOptions, DownstreamAgentConfig } from "../core/types.ts";

interface DefaultSessionPromptOptions {
  onUpdate?: CallAgentOptions["onUpdate"];
  signal?: AbortSignal;
  softStopSignal?: AbortSignal;
  timingTrace?: RunTimingTrace;
}

interface DefaultSessionPromptResult {
  raw: string;
  logFile?: string;
  updates: acp.SessionUpdate[];
  durationMs: number;
  tokenSnapshot?: AgentTokenSnapshot;
}

interface PromptCollector {
  raw: string;
  updates: acp.SessionUpdate[];
  onUpdate?: CallAgentOptions["onUpdate"];
  lastTask: Promise<void>;
}

interface DefaultConversationSessionParams {
  config: DownstreamAgentConfig;
  persistedSessionId?: acp.SessionId;
}

export class DefaultConversationSession {
  private persistedSessionId?: acp.SessionId;
  private liveSession?: PersistentAcpSession;
  private config: DownstreamAgentConfig;
  private lastTokenSnapshot?: AgentTokenSnapshot;
  private sessionPromise?: Promise<PersistentAcpSession>;
  private sessionGeneration = 0;

  constructor(params: DefaultConversationSessionParams) {
    this.config = params.config;
    this.persistedSessionId = params.persistedSessionId;
  }

  get currentSessionId(): string | undefined {
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
    prompt: string,
    options: DefaultSessionPromptOptions = {},
  ): Promise<DefaultSessionPromptResult> {
    const startedAt = Date.now();
    appendTimingTraceEvent(options.timingTrace, "default_session", "prompt_started");
    const session = await this.ensureSession(options.timingTrace);

    try {
      const result = await session.prompt(prompt, options);
      this.persistedSessionId = session.sessionId;
      this.lastTokenSnapshot = result.tokenSnapshot ?? this.lastTokenSnapshot;
      return {
        ...result,
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
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

    this.closeLiveSession();
    this.persistedSessionId = undefined;
    this.lastTokenSnapshot = undefined;
    this.config = config;
  }

  closeLiveSession(): void {
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
      session = await PersistentAcpSession.load(this.config, this.persistedSessionId);
      appendTimingTraceEvent(timingTrace, "default_session", "load_session_attempt_completed", {
        sessionId: this.persistedSessionId,
        loaded: session !== undefined,
      });
    }

    if (!session) {
      appendTimingTraceEvent(timingTrace, "default_session", "create_fresh_session_started");
      session = await PersistentAcpSession.createFresh(this.config);
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
  ): Promise<PersistentAcpSession> {
    const state = await openAcpConnection(config);

    try {
      const session = await state.connection.newSession({
        cwd: state.cwd,
        mcpServers: [buildGlobalMcpStdioServer()],
      });
      const runtime = new PersistentAcpSession(state, config, session.sessionId);
      await applyAcpSessionConfig(state.connection, session.sessionId, config);
      return runtime;
    } catch (error) {
      closeAcpConnection(state);
      throw error;
    }
  }

  static async load(
    config: DownstreamAgentConfig,
    sessionId: acp.SessionId,
  ): Promise<PersistentAcpSession | undefined> {
    const state = await openAcpConnection(config);

    try {
      if (!state.capabilities?.loadSession) {
        closeAcpConnection(state);
        return undefined;
      }

      await state.connection.loadSession({
        cwd: state.cwd,
        mcpServers: [buildGlobalMcpStdioServer()],
        sessionId,
      });

      const runtime = new PersistentAcpSession(state, config, sessionId);
      await applyAcpSessionConfig(state.connection, sessionId, config);
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
    prompt: string,
    options: DefaultSessionPromptOptions = {},
  ): Promise<{ raw: string; logFile?: string; updates: acp.SessionUpdate[]; tokenSnapshot?: AgentTokenSnapshot }> {
    if (!this.isAlive()) {
      throw new Error("Default ACP session is not available");
    }

    if (options.softStopSignal?.aborted) {
      throw new RunCancelledError(defaultCancellationMessage("soft_stop"), "soft_stop");
    }

    if (options.signal?.aborted) {
      this.close();
      throw new RunCancelledError(defaultCancellationMessage("abort"), "abort");
    }

    const collector: PromptCollector = {
      raw: "",
      updates: [],
      onUpdate: options.onUpdate,
      lastTask: Promise.resolve(),
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
        promptResponse = await this.state.connection.prompt({
          sessionId: this.sessionId,
          prompt: [
            {
              type: "text",
              text: prompt,
            },
          ],
        });
      } catch (error) {
        if (options.softStopSignal?.aborted) {
          throw new RunCancelledError(defaultCancellationMessage("soft_stop"), "soft_stop");
        }
        throw error;
      }

      await this.waitForCollectorToSettle(collector);
      this.tokenSnapshot = await collectTokenSnapshot({
        childPid: this.state.child.pid,
        config: this.config,
        promptResponse,
        sessionId: this.sessionId,
        updates: collector.updates,
      }) ?? this.tokenSnapshot;

      return {
        raw: collector.raw,
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

      if (
        update.sessionUpdate === "agent_message_chunk" &&
        update.content.type === "text"
      ) {
        if (!parseAssistantNoticeText(update.content.text)) {
          collector.raw += update.content.text;
        }
      }

      await collector.onUpdate?.(update);
    });

    collector.lastTask = task;
    this.updateQueue = task.catch(() => {});
    await task;
  }

  private async waitForCollectorToSettle(collector: PromptCollector): Promise<void> {
    const settleMs = getPromptSettleMs();
    for (;;) {
      const currentTask = collector.lastTask;
      await currentTask;
      await Bun.sleep(settleMs);
      if (collector.lastTask === currentTask) {
        return;
      }
    }
  }
}

function getPromptSettleMs(): number {
  const value = Number(process.env.NANOBOSS_ACP_PROMPT_SETTLE_MS ?? "50");
  return Number.isFinite(value) && value >= 0 ? value : 50;
}

function sameAgentConfig(left: DownstreamAgentConfig, right: DownstreamAgentConfig): boolean {
  return (
    left.provider === right.provider &&
    left.command === right.command &&
    left.cwd === right.cwd &&
    left.model === right.model &&
    left.reasoningEffort === right.reasoningEffort &&
    sameStringArray(left.args, right.args) &&
    sameStringRecord(left.env, right.env)
  );
}

function sameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameStringRecord(
  left: Record<string, string> | undefined,
  right: Record<string, string> | undefined,
): boolean {
  const leftEntries = Object.entries(left ?? {}).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
  const rightEntries = Object.entries(right ?? {}).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));

  return (
    leftEntries.length === rightEntries.length &&
    leftEntries.every(([key, value], index) => {
      const rightEntry = rightEntries[index];
      return rightEntry !== undefined && key === rightEntry[0] && value === rightEntry[1];
    })
  );
}
