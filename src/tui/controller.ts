import { buildModelCommand } from "../core/model-command.ts";
import { resolveDownstreamAgentConfig } from "../core/config.ts";
import { getBuildLabel } from "../core/build-info.ts";
import { getBuildFreshnessNotice } from "../core/build-freshness.ts";
import { ensureMatchingHttpServer } from "../http/server-supervisor.ts";
import {
  cancelSessionRun,
  createHttpSession,
  resumeHttpSession,
  sendSessionPrompt,
  startSessionEventStream,
  type SessionStreamHandle,
} from "../http/client.ts";
import type { FrontendCommand, FrontendEventEnvelope } from "../http/frontend-events.ts";
import { formatAgentBanner } from "../core/runtime-banner.ts";
import type { DownstreamAgentSelection } from "../core/types.ts";

import {
  isExitRequest,
  isModelPickerRequest,
  isNewSessionRequest,
  parseModelSelectionCommand,
  parseToolCardThemeCommand,
} from "./commands.ts";
import { reduceUiState, type UiAction } from "./reducer.ts";
import { createInitialUiState, type UiState } from "./state.ts";

export interface SessionResponse {
  sessionId: string;
  cwd: string;
  commands: FrontendCommand[];
  buildLabel: string;
  agentLabel: string;
  defaultAgentSelection?: DownstreamAgentSelection;
}

export interface NanobossTuiControllerParams {
  cwd?: string;
  serverUrl: string;
  showToolCalls: boolean;
  sessionId?: string;
}

export interface NanobossTuiControllerDeps {
  ensureMatchingHttpServer?: typeof ensureMatchingHttpServer;
  createHttpSession?: typeof createHttpSession;
  resumeHttpSession?: typeof resumeHttpSession;
  sendSessionPrompt?: typeof sendSessionPrompt;
  cancelSessionRun?: typeof cancelSessionRun;
  startSessionEventStream?: (params: {
    baseUrl: string;
    sessionId: string;
    onEvent: (event: FrontendEventEnvelope) => void;
    onError?: (error: unknown) => void;
  }) => SessionStreamHandle;
  promptForModelSelection?: (
    currentSelection?: DownstreamAgentSelection,
  ) => Promise<DownstreamAgentSelection | undefined>;
  confirmPersistDefaultAgentSelection?: (
    selection: DownstreamAgentSelection,
  ) => Promise<boolean>;
  persistDefaultAgentSelection?: (selection: DownstreamAgentSelection) => Promise<void> | void;
  onStateChange?: (state: UiState) => void;
  onExit?: () => void;
  onClearInput?: () => void;
  onAddHistory?: (text: string) => void;
}

export class NanobossTuiController {
  private readonly cwd: string;
  private state: UiState;
  private stream?: SessionStreamHandle;
  private stopped = false;
  private exitResolver?: () => void;
  private readonly exited: Promise<void>;

  constructor(
    private readonly params: NanobossTuiControllerParams,
    private readonly deps: NanobossTuiControllerDeps = {},
  ) {
    this.cwd = params.cwd ?? process.cwd();
    this.state = createInitialUiState({
      cwd: this.cwd,
      buildLabel: getBuildLabel(),
      agentLabel: "connecting",
      showToolCalls: params.showToolCalls,
    });
    this.exited = new Promise<void>((resolve) => {
      this.exitResolver = resolve;
    });
  }

  getState(): UiState {
    return this.state;
  }

  async run(): Promise<string | undefined> {
    try {
      const buildFreshnessNotice = getBuildFreshnessNotice(this.cwd);
      if (buildFreshnessNotice) {
        this.dispatch({ type: "local_status", text: buildFreshnessNotice });
      }

      await (this.deps.ensureMatchingHttpServer ?? ensureMatchingHttpServer)(this.params.serverUrl, {
        cwd: this.cwd,
        onStatus: (text) => {
          this.dispatch({ type: "local_status", text });
        },
      });

      const session = this.params.sessionId
        ? await (this.deps.resumeHttpSession ?? resumeHttpSession)(
          this.params.serverUrl,
          this.params.sessionId,
          this.cwd,
        )
        : await (this.deps.createHttpSession ?? createHttpSession)(
          this.params.serverUrl,
          this.cwd,
        );
      await this.applySession(session);
      if (this.params.sessionId) {
        this.dispatch({ type: "local_status", text: `[session] resumed ${session.sessionId}` });
      }

      await this.exited;
      return this.state.sessionId || session.sessionId;
    } finally {
      await this.stop();
    }
  }

  async handleSubmit(text: string): Promise<void> {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      return;
    }

    if (isExitRequest(trimmed)) {
      this.deps.onClearInput?.();
      this.requestExit();
      return;
    }

    const toolCardThemeMode = parseToolCardThemeCommand(trimmed);
    if (toolCardThemeMode) {
      this.deps.onClearInput?.();
      this.dispatch({ type: "local_tool_card_theme_mode", mode: toolCardThemeMode });
      return;
    }

    if (this.state.inputDisabled) {
      return;
    }

    if (isNewSessionRequest(trimmed)) {
      this.deps.onClearInput?.();
      await this.createNewSession();
      return;
    }

    if (isModelPickerRequest(trimmed)) {
      await this.openModelPicker();
      return;
    }

    const inlineSelection = parseModelSelectionCommand(trimmed);
    if (inlineSelection) {
      this.applyLocalSelection(inlineSelection);
      await this.maybePersistDefaultSelection(inlineSelection);
    }

    this.deps.onAddHistory?.(text);
    this.deps.onClearInput?.();
    await this.forwardPrompt(text);
  }

  async cancelActiveRun(): Promise<void> {
    if (!this.state.inputDisabled || !this.state.sessionId) {
      return;
    }

    const activeRunId = this.state.activeRunId;
    const stopAlreadyLatched = this.state.pendingStopRequest
      || (activeRunId !== undefined && this.state.stopRequestedRunId === activeRunId);
    if (stopAlreadyLatched) {
      return;
    }

    this.dispatch({
      type: "local_stop_requested",
      runId: activeRunId,
    });

    if (activeRunId) {
      await this.sendStopRequest(activeRunId);
    }
  }

  toggleToolOutput(): void {
    this.dispatch({ type: "toggle_tool_output" });
  }

  requestExit(): void {
    if (this.stopped) {
      return;
    }

    this.deps.onExit?.();
    this.exitResolver?.();
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }

    this.stopped = true;
    if (this.stream) {
      this.stream.close();
      await this.stream.closed;
      this.stream = undefined;
    }
  }

  private dispatch(action: UiAction): void {
    this.state = reduceUiState(this.state, action);
    this.deps.onStateChange?.(this.state);
  }

  private async applySession(session: SessionResponse): Promise<void> {
    if (this.stream) {
      this.stream.close();
      await this.stream.closed;
    }

    this.dispatch({
      type: "session_ready",
      sessionId: session.sessionId,
      cwd: session.cwd,
      buildLabel: session.buildLabel,
      agentLabel: session.agentLabel,
      commands: session.commands,
      defaultAgentSelection: session.defaultAgentSelection,
    });

    this.stream = (this.deps.startSessionEventStream ?? startSessionEventStream)({
      baseUrl: this.params.serverUrl,
      sessionId: session.sessionId,
      onEvent: (event) => {
        this.dispatch({ type: "frontend_event", event });
        this.maybeSendLatchedStopRequest(event);
      },
      onError: (error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.dispatch({ type: "local_status", text: `[stream] ${message}` });
      },
    });
  }

  private maybeSendLatchedStopRequest(event: FrontendEventEnvelope): void {
    if (event.type !== "run_started" || this.state.stopRequestedRunId !== event.data.runId) {
      return;
    }

    void this.sendStopRequest(event.data.runId);
  }

  private async sendStopRequest(runId: string): Promise<void> {
    const sessionId = this.state.sessionId;
    if (!sessionId) {
      return;
    }

    try {
      await (this.deps.cancelSessionRun ?? cancelSessionRun)(
        this.params.serverUrl,
        sessionId,
        runId,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.dispatch({
        type: "local_stop_request_failed",
        runId,
        text: `[run] cancel failed: ${message}`,
      });
    }
  }

  private async createNewSession(): Promise<void> {
    this.dispatch({ type: "local_status", text: "[session] creating new session…" });

    try {
      const session = await (this.deps.createHttpSession ?? createHttpSession)(
        this.params.serverUrl,
        this.cwd,
        this.state.defaultAgentSelection,
      );
      await this.applySession(session);
      this.dispatch({ type: "local_status", text: `[session] new ${session.sessionId}` });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.dispatch({ type: "local_status", text: `[session] ${message}` });
    }
  }

  private async openModelPicker(): Promise<void> {
    const selection = await this.deps.promptForModelSelection?.(this.state.defaultAgentSelection);
    if (!selection) {
      return;
    }

    this.applyLocalSelection(selection);
    await this.maybePersistDefaultSelection(selection);
    const command = buildModelCommand(selection.provider, selection.model ?? "default");
    this.deps.onAddHistory?.(command);
    this.deps.onClearInput?.();
    await this.forwardPrompt(command);
  }

  private applyLocalSelection(selection: DownstreamAgentSelection): void {
    const agentLabel = formatAgentBanner(resolveDownstreamAgentConfig(this.cwd, selection));
    this.dispatch({
      type: "local_agent_selection",
      agentLabel,
      selection,
    });
  }

  private async maybePersistDefaultSelection(selection: DownstreamAgentSelection): Promise<void> {
    const confirm = this.deps.confirmPersistDefaultAgentSelection;
    const persist = this.deps.persistDefaultAgentSelection;
    if (!confirm || !persist) {
      return;
    }

    try {
      const shouldPersist = await confirm(selection);
      if (!shouldPersist) {
        return;
      }

      await persist(selection);
      const banner = formatAgentBanner(resolveDownstreamAgentConfig(this.cwd, selection));
      this.dispatch({ type: "local_status", text: `[model] saved ${banner} as the default for future runs` });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.dispatch({ type: "local_status", text: `[model] failed to save default: ${message}` });
    }
  }

  private async forwardPrompt(prompt: string): Promise<void> {
    this.dispatch({ type: "local_user_submitted", text: prompt });

    try {
      if (!this.state.sessionId) {
        throw new Error("No active session");
      }

      await (this.deps.sendSessionPrompt ?? sendSessionPrompt)(
        this.params.serverUrl,
        this.state.sessionId,
        prompt,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.dispatch({ type: "local_send_failed", error: message });
    }
  }
}
