import type * as acp from "@agentclientprotocol/sdk";

import {
  applyAcpSessionConfig,
  closeAcpConnection,
  openAcpConnection,
  type OpenAcpConnection,
} from "./acp-runtime.ts";
import { buildGlobalMcpStdioServer } from "../mcp/registration.ts";
import { RunCancelledError, defaultCancellationMessage } from "../core/cancellation.ts";
import { collectTokenSnapshot, enrichToolCallUpdateWithTokenUsage } from "./token-metrics.ts";
import type { AgentTokenSnapshot, CallAgentOptions, DownstreamAgentConfig } from "../core/types.ts";

interface DefaultSessionPromptOptions {
  onUpdate?: CallAgentOptions["onUpdate"];
  signal?: AbortSignal;
  softStopSignal?: AbortSignal;
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
}

interface DefaultConversationSessionParams {
  config: DownstreamAgentConfig;
  sessionId: string;
  rootDir?: string;
  persistedSessionId?: acp.SessionId;
}

export class DefaultConversationSession {
  private persistedSessionId?: acp.SessionId;
  private liveSession?: PersistentAcpSession;
  private readonly sessionId: string;
  private readonly rootDir?: string;
  private config: DownstreamAgentConfig;
  private lastTokenSnapshot?: AgentTokenSnapshot;

  constructor(params: DefaultConversationSessionParams) {
    this.config = params.config;
    this.sessionId = params.sessionId;
    this.rootDir = params.rootDir;
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

  async prompt(
    prompt: string,
    options: DefaultSessionPromptOptions = {},
  ): Promise<DefaultSessionPromptResult> {
    const startedAt = Date.now();
    let session = this.liveSession;

    if (!session?.isAlive()) {
      session?.close();
      this.liveSession = undefined;
      session = undefined;
    }

    if (!session && this.persistedSessionId) {
      session = await PersistentAcpSession.load(
        this.config,
        this.persistedSessionId,
        this.sessionId,
        this.rootDir,
      );
      if (session) {
        this.liveSession = session;
      }
    }

    if (!session) {
      session = await PersistentAcpSession.createFresh(this.config, this.sessionId, this.rootDir);
      this.liveSession = session;
    }

    this.persistedSessionId = session.sessionId;

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
    this.liveSession?.close();
    this.liveSession = undefined;
  }
}

class PersistentAcpSession {
  private activeCollector?: PromptCollector;
  private closed = false;
  private tokenSnapshot?: AgentTokenSnapshot;

  private constructor(
    private readonly state: OpenAcpConnection,
    private readonly config: DownstreamAgentConfig,
    readonly sessionId: acp.SessionId,
  ) {
    this.state.setSessionUpdateHandler((params) => this.handleSessionUpdate(params));
  }

  static async createFresh(
    config: DownstreamAgentConfig,
    _sessionId: string,
    _rootDir?: string,
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
    _nanobossSessionId: string,
    _rootDir?: string,
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
        updates: collector.updates,
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

    if (params.sessionId !== this.sessionId || !this.activeCollector) {
      return;
    }

    const { update, tokenSnapshot } = await enrichToolCallUpdateWithTokenUsage({
      childPid: this.state.child.pid,
      config: this.config,
      sessionId: this.sessionId,
      update: params.update,
      updates: this.activeCollector.updates,
    });
    this.tokenSnapshot = tokenSnapshot ?? this.tokenSnapshot;
    this.activeCollector.updates.push(update);

    if (
      update.sessionUpdate === "agent_message_chunk" &&
      update.content.type === "text"
    ) {
      this.activeCollector.raw += update.content.text;
    }

    await this.activeCollector.onUpdate?.(update);
  }
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
