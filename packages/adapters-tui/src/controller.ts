import {
  cancelSessionRun,
  createHttpSession,
  ensureMatchingHttpServer,
  resumeHttpSession,
  setSessionAutoApprove,
  sendSessionPrompt,
  startSessionEventStream,
  isRenderedFrontendEvent,
  type FrontendCommand,
  type FrontendEventEnvelope,
  type SessionStreamHandle,
} from "@nanoboss/adapters-http";
import type { DownstreamAgentSelection, PromptInput } from "@nanoboss/contracts";
import { getBuildLabel } from "@nanoboss/app-support";
import {
  createTextPromptInput,
  normalizePromptInput,
  promptInputDisplayText,
} from "@nanoboss/procedure-sdk";

import { formatAgentSelectionLabel } from "./agent-label.ts";
import { getBuildFreshnessNotice } from "./build-freshness.ts";
import { buildModelCommand } from "./model-command.ts";
import {
  isExitRequest,
  isModelPickerRequest,
  isNewSessionRequest,
  parseModelSelectionCommand,
  parseToolCardThemeCommand,
} from "./commands.ts";
import { reduceUiState, type UiAction } from "./reducer.ts";
import { createInitialUiState, type UiPendingPrompt, type UiState } from "./state.ts";

export interface SessionResponse {
  sessionId: string;
  cwd: string;
  commands: FrontendCommand[];
  buildLabel: string;
  agentLabel: string;
  autoApprove: boolean;
  defaultAgentSelection?: DownstreamAgentSelection;
}

export interface NanobossTuiControllerParams {
  cwd?: string;
  serverUrl: string;
  showToolCalls: boolean;
  sessionId?: string;
  simplify2AutoApprove?: boolean;
}

export interface NanobossTuiControllerDeps {
  ensureMatchingHttpServer?: typeof ensureMatchingHttpServer;
  createHttpSession?: typeof createHttpSession;
  resumeHttpSession?: typeof resumeHttpSession;
  setSessionAutoApprove?: typeof setSessionAutoApprove;
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
  private flushingPendingPrompt = false;
  private nextPendingPromptId = 1;
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
      simplify2AutoApprove: params.simplify2AutoApprove,
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
          this.params.simplify2AutoApprove,
        )
        : await (this.deps.createHttpSession ?? createHttpSession)(
          this.params.serverUrl,
          this.cwd,
          this.params.simplify2AutoApprove,
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

  async handleSubmit(input: string | PromptInput): Promise<void> {
    const promptInput = normalizePromptInput(input);
    const text = promptInputDisplayText(promptInput);
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
      const blockedCommand = getBusyLocalCommandLabel(trimmed);
      if (blockedCommand) {
        this.dispatch({
          type: "local_status",
          text: `[run] wait for the current run to finish before using ${blockedCommand}`,
        });
        return;
      }

      this.deps.onAddHistory?.(text);
      this.deps.onClearInput?.();
      await this.enqueuePendingPrompt(promptInput, "steering");
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
    await this.forwardPrompt(promptInput);
  }

  async queuePrompt(input: string | PromptInput): Promise<void> {
    const promptInput = normalizePromptInput(input);
    const text = promptInputDisplayText(promptInput);
    const trimmed = text.trim();
    if (trimmed.length === 0 || !this.state.inputDisabled) {
      return;
    }

    const blockedCommand = getBusyLocalCommandLabel(trimmed);
    if (blockedCommand) {
      this.dispatch({
        type: "local_status",
        text: `[run] wait for the current run to finish before using ${blockedCommand}`,
      });
      return;
    }

    this.deps.onAddHistory?.(text);
    this.deps.onClearInput?.();
    await this.enqueuePendingPrompt(promptInput, "queued");
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

  toggleSimplify2AutoApprove(): void {
    void this.toggleSessionAutoApprove();
  }

  showStatus(text: string): void {
    this.dispatch({ type: "local_status", text });
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
      autoApprove: session.autoApprove,
      commands: session.commands,
      defaultAgentSelection: session.defaultAgentSelection,
    });

    this.stream = (this.deps.startSessionEventStream ?? startSessionEventStream)({
      baseUrl: this.params.serverUrl,
      sessionId: session.sessionId,
      onEvent: (event) => {
        if (isRenderedFrontendEvent(event)) {
          this.dispatch({ type: "frontend_event", event });
        }
        this.maybeSendLatchedStopRequest(event);
        void this.maybeFlushPendingPrompt(event);
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

  private async enqueuePendingPrompt(promptInput: PromptInput, kind: UiPendingPrompt["kind"]): Promise<void> {
    const text = promptInputDisplayText(promptInput);
    this.dispatch({
      type: "local_pending_prompt_added",
      prompt: {
        id: `pending-${this.nextPendingPromptId++}`,
        text,
        kind,
        promptInput,
      },
    });

    if (kind === "steering") {
      await this.cancelActiveRun();
    }
  }

  private async maybeFlushPendingPrompt(event: FrontendEventEnvelope): Promise<void> {
    if (!isTerminalFrontendEvent(event) || this.flushingPendingPrompt || this.state.inputDisabled) {
      return;
    }

    const nextPrompt = selectNextPendingPrompt(this.state.pendingPrompts);
    if (!nextPrompt) {
      return;
    }

    this.flushingPendingPrompt = true;
    this.dispatch({
      type: "local_pending_prompt_removed",
      promptId: nextPrompt.id,
    });

    try {
      const forwarded = await this.forwardPrompt(nextPrompt.promptInput ?? normalizePromptInput(nextPrompt.text));
      if (!forwarded && this.state.pendingPrompts.length > 0) {
        this.dispatch({
          type: "local_pending_prompts_cleared",
          text: formatPendingPromptClearStatus(this.state.pendingPrompts.length),
        });
      }
    } finally {
      this.flushingPendingPrompt = false;
    }
  }

  private async createNewSession(): Promise<void> {
    this.dispatch({ type: "local_status", text: "[session] creating new session…" });

    try {
      const session = await (this.deps.createHttpSession ?? createHttpSession)(
        this.params.serverUrl,
        this.cwd,
        this.state.simplify2AutoApprove,
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
    this.deps.onClearInput?.();
    const selection = await this.deps.promptForModelSelection?.(this.state.defaultAgentSelection);
    if (!selection) {
      return;
    }

    this.applyLocalSelection(selection);
    await this.maybePersistDefaultSelection(selection);
    const command = buildModelCommand(selection.provider, selection.model ?? "default");
    this.deps.onAddHistory?.(command);
    await this.forwardPrompt(createTextPromptInput(command));
  }

  private applyLocalSelection(selection: DownstreamAgentSelection): void {
    this.dispatch({
      type: "local_agent_selection",
      agentLabel: formatAgentSelectionLabel(selection),
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
      this.dispatch({
        type: "local_status",
        text: `[model] saved ${formatAgentSelectionLabel(selection)} as the default for future runs`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.dispatch({ type: "local_status", text: `[model] failed to save default: ${message}` });
    }
  }

  private async forwardPrompt(prompt: PromptInput): Promise<boolean> {
    this.dispatch({ type: "local_user_submitted", text: promptInputDisplayText(prompt) });

    try {
      if (!this.state.sessionId) {
        throw new Error("No active session");
      }

      await (this.deps.sendSessionPrompt ?? sendSessionPrompt)(
        this.params.serverUrl,
        this.state.sessionId,
        prompt,
      );
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.dispatch({ type: "local_send_failed", error: message });
      return false;
    }
  }

  private async toggleSessionAutoApprove(): Promise<void> {
    const sessionId = this.state.sessionId;
    if (!sessionId) {
      return;
    }

    const enabled = !this.state.simplify2AutoApprove;
    try {
      const session = await (this.deps.setSessionAutoApprove ?? setSessionAutoApprove)(
        this.params.serverUrl,
        sessionId,
        enabled,
      );
      this.dispatch({ type: "session_auto_approve", enabled: session.autoApprove });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.dispatch({ type: "local_status", text: `[session] failed to update auto-approve: ${message}` });
    }
  }
}

function getBusyLocalCommandLabel(trimmed: string): string | undefined {
  if (trimmed === "/new") {
    return "/new";
  }

  if (trimmed === "/model" || trimmed.startsWith("/model ")) {
    return "/model";
  }

  return undefined;
}

function isTerminalFrontendEvent(event: FrontendEventEnvelope): boolean {
  return event.type === "run_completed"
    || event.type === "run_paused"
    || event.type === "run_failed"
    || event.type === "run_cancelled";
}

function selectNextPendingPrompt(prompts: UiPendingPrompt[]): UiPendingPrompt | undefined {
  return prompts.find((prompt) => prompt.kind === "steering")
    ?? prompts.find((prompt) => prompt.kind === "queued");
}

function formatPendingPromptClearStatus(count: number): string {
  return `[run] cleared ${count} pending prompt${count === 1 ? "" : "s"} after send failed`;
}
