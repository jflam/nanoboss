import {
  setSessionAutoApprove,
  startSessionEventStream,
  isRenderedFrontendEvent,
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

import { buildModelCommand } from "./model-command.ts";
import {
  isExitRequest,
  isExtensionsListRequest,
  isModelPickerRequest,
  isNewSessionRequest,
  parseModelSelectionCommand,
  parseToolCardThemeCommand,
} from "./commands.ts";
import { reduceUiState, type UiAction } from "./reducer.ts";
import { createInitialUiState, type UiPendingPrompt, type UiState } from "./state.ts";
import {
  getBusyLocalCommandLabel,
  getLocalBusyInputStatus,
} from "./controller-input-flow.ts";
import {
  buildExtensionsLocalCard,
  createLocalCardAction,
  type ControllerLocalCardOptions,
} from "./controller-local-cards.ts";
import {
  createLocalAgentSelectionAction,
  maybePersistDefaultSelection as maybePersistDefaultSelectionInternal,
  validateInlineModelSelection as validateInlineModelSelectionInternal,
} from "./controller-model-selection.ts";
import {
  connectControllerSession,
  createControllerSession,
} from "./controller-session.ts";
import {
  cancelActiveRun as cancelActiveRunInternal,
  handleContinuationCancel as handleContinuationCancelInternal,
  maybeSendLatchedStopRequest as maybeSendLatchedStopRequestInternal,
  sendStopRequest as sendStopRequestInternal,
} from "./controller-stop.ts";
import {
  buildPendingPromptAction,
  forwardPrompt as forwardPromptInternal,
  maybeFlushPendingPrompt as maybeFlushPendingPromptInternal,
} from "./controller-prompt-flow.ts";
export type {
  NanobossTuiControllerDeps,
  NanobossTuiControllerParams,
  SessionResponse,
} from "./controller-types.ts";
import type {
  NanobossTuiControllerDeps,
  NanobossTuiControllerParams,
  SessionResponse,
} from "./controller-types.ts";

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
      const { session, buildFreshnessNotice } = await connectControllerSession({
        deps: this.deps,
        serverUrl: this.params.serverUrl,
        cwd: this.cwd,
        sessionId: this.params.sessionId,
        simplify2AutoApprove: this.params.simplify2AutoApprove,
        onStatus: (text) => {
          this.dispatch({ type: "local_status", text });
        },
      });
      await this.applySession(session);
      // Cards are emitted *after* applySession because session_ready
      // resets procedurePanels as part of initial-state derivation.
      if (buildFreshnessNotice) {
        this.showLocalCard({
          key: "local:build-freshness",
          title: "Build",
          markdown: buildFreshnessNotice,
          severity: "warn",
        });
      }
      if (this.params.sessionId) {
        this.showLocalCard({
          key: "local:session",
          title: "Session",
          markdown: `Resumed session \`${session.sessionId}\`.`,
          severity: "info",
        });
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
      this.showLocalCard({
        key: "local:tool-theme",
        title: "Tool cards",
        markdown: `Theme set to **${toolCardThemeMode}**.`,
        severity: "info",
      });
      return;
    }

    if (this.state.inputDisabled) {
      if (this.state.inputDisabledReason === "local") {
        this.dispatch({
          type: "local_status",
          text: getLocalBusyInputStatus(this.state.statusLine),
        });
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
      await this.enqueuePendingPrompt(promptInput, "steering");
      return;
    }

    if (isNewSessionRequest(trimmed)) {
      this.deps.onClearInput?.();
      await this.createNewSession();
      return;
    }

    if (isExtensionsListRequest(trimmed)) {
      this.deps.onClearInput?.();
      this.emitExtensionsList();
      return;
    }

    if (isModelPickerRequest(trimmed)) {
      await this.openModelPicker();
      return;
    }

    const inlineSelection = parseModelSelectionCommand(trimmed);
    if (inlineSelection) {
      const validatedSelection = await this.validateInlineModelSelection(inlineSelection);
      if (validatedSelection) {
        this.applyLocalSelection(validatedSelection);
        await this.maybePersistDefaultSelection(validatedSelection);
      }
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

    if (this.state.inputDisabledReason === "local") {
      this.dispatch({
        type: "local_status",
        text: getLocalBusyInputStatus(this.state.statusLine),
      });
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
    await cancelActiveRunInternal({
      state: this.state,
      dispatch: (action) => this.dispatch(action),
      handleContinuationCancel: async () => await this.handleContinuationCancel(),
      sendStopRequest: async (runId) => await this.sendStopRequest(runId),
    });
  }

  /**
   * Cancels the currently paused continuation via the engine's
   * `requestContinuationCancel` entry point. Does NOT attempt to route the
   * user's input through `resume`; the reducer's existing `run_cancelled`
   * handling (from step 1) will clear `pendingContinuation` and restore the
   * default session.
   */
  async handleContinuationCancel(): Promise<void> {
    await handleContinuationCancelInternal({
      deps: this.deps,
      serverUrl: this.params.serverUrl,
      state: this.state,
      dispatch: (action) => this.dispatch(action),
    });
  }

  toggleToolOutput(): void {
    this.dispatch({ type: "toggle_tool_output" });
  }

  toggleToolCardsHidden(): void {
    this.dispatch({ type: "toggle_tool_cards_hidden" });
  }

  toggleSimplify2AutoApprove(): void {
    void this.toggleSessionAutoApprove();
  }

  async handleEscape(): Promise<void> {
    await this.cancelActiveRun();
  }

  showStatus(text: string): void {
    this.dispatch({ type: "local_status", text });
  }

  /**
   * Render a small, user-facing card in the transcript as a local
   * `nb/card@1` procedure panel. Used for slash-command output and
   * other controller-originated messages that users need to actually
   * read — the status line scrolls out of view too quickly for these.
   *
   * When a stable `key` is passed, repeated invocations replace the
   * previous card in place (see the `local_procedure_panel` reducer
   * path) so the transcript does not fill up with duplicates. Omit
   * `key` for affordances where each invocation should append a fresh
   * card (e.g. the ctrl+h keybinding help).
   */
  showLocalCard(opts: ControllerLocalCardOptions): void {
    this.dispatch(createLocalCardAction(opts));
  }

  private emitExtensionsList(): void {
    this.showLocalCard(buildExtensionsLocalCard(this.deps.listExtensionEntries));
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
    maybeSendLatchedStopRequestInternal({
      event,
      state: this.state,
      sendStopRequest: (runId) => {
        void this.sendStopRequest(runId);
      },
    });
  }

  private async sendStopRequest(runId: string): Promise<void> {
    await sendStopRequestInternal({
      deps: this.deps,
      serverUrl: this.params.serverUrl,
      state: this.state,
      runId,
      dispatch: (action) => this.dispatch(action),
    });
  }

  private async enqueuePendingPrompt(promptInput: PromptInput, kind: UiPendingPrompt["kind"]): Promise<void> {
    const pendingPrompt = buildPendingPromptAction({
      promptInput,
      kind,
      nextPendingPromptId: this.nextPendingPromptId,
    });
    this.nextPendingPromptId = pendingPrompt.nextPendingPromptId;
    this.dispatch(pendingPrompt.action);

    if (kind === "steering") {
      await this.cancelActiveRun();
    }
  }

  private async maybeFlushPendingPrompt(event: FrontendEventEnvelope): Promise<void> {
    await maybeFlushPendingPromptInternal({
      event,
      getState: () => this.state,
      flushingPendingPrompt: this.flushingPendingPrompt,
      setFlushingPendingPrompt: (flushing) => {
        this.flushingPendingPrompt = flushing;
      },
      forwardPrompt: async (prompt) => await this.forwardPrompt(prompt),
      dispatch: (action) => this.dispatch(action),
    });
  }

  private async createNewSession(): Promise<void> {
    this.dispatch({ type: "local_status", text: "[session] creating new session…" });

    try {
      const session = await createControllerSession({
        deps: this.deps,
        serverUrl: this.params.serverUrl,
        cwd: this.cwd,
        simplify2AutoApprove: this.state.simplify2AutoApprove,
        defaultAgentSelection: this.state.defaultAgentSelection,
      });
      await this.applySession(session);
      // applySession dispatches session_ready which resets procedurePanels,
      // so the confirmation card is emitted *after* the reset to survive.
      this.showLocalCard({
        key: "local:session",
        title: "Session",
        markdown: `Started new session \`${session.sessionId}\`.`,
        severity: "info",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.showLocalCard({
        key: "local:session",
        title: "Session",
        markdown: `Failed to create new session: ${message}`,
        severity: "error",
      });
    }
  }

  private async openModelPicker(): Promise<void> {
    this.deps.onClearInput?.();
    let selection: DownstreamAgentSelection | undefined;
    try {
      selection = await this.withLocalBusy(
        "[model] choose an agent",
        async () => await this.deps.promptForModelSelection?.(this.state.defaultAgentSelection),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.showLocalCard({
        key: "local:model",
        title: "Model",
        markdown: `Model picker failed: ${message}`,
        severity: "error",
      });
      return;
    }

    if (!selection) {
      return;
    }

    this.applyLocalSelection(selection);
    await this.maybePersistDefaultSelection(selection);
    const command = buildModelCommand(selection.provider, selection.model ?? "default");
    this.deps.onAddHistory?.(command);
    await this.forwardPrompt(createTextPromptInput(command));
  }

  private async validateInlineModelSelection(
    selection: DownstreamAgentSelection,
  ): Promise<DownstreamAgentSelection | undefined> {
    return await validateInlineModelSelectionInternal({
      selection,
      cwd: this.cwd,
      deps: this.deps,
      withLocalBusy: async (status, work) => await this.withLocalBusy(status, work),
      showLocalCard: (opts) => this.showLocalCard(opts),
    });
  }

  private applyLocalSelection(selection: DownstreamAgentSelection): void {
    this.dispatch(createLocalAgentSelectionAction(selection));
  }

  private async maybePersistDefaultSelection(selection: DownstreamAgentSelection): Promise<void> {
    await maybePersistDefaultSelectionInternal({
      selection,
      deps: this.deps,
      showLocalCard: (opts) => this.showLocalCard(opts),
    });
  }

  private async withLocalBusy<T>(status: string, work: () => Promise<T>): Promise<T> {
    this.dispatch({ type: "local_busy_started", text: status });
    try {
      return await work();
    } finally {
      this.dispatch({ type: "local_busy_finished" });
    }
  }

  private async forwardPrompt(prompt: PromptInput): Promise<boolean> {
    return await forwardPromptInternal({
      deps: this.deps,
      serverUrl: this.params.serverUrl,
      state: this.state,
      prompt,
      dispatch: (action) => this.dispatch(action),
    });
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
