import {
  cancelSessionContinuation,
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
  discoverAgentCatalog,
  formatAgentCatalogRefreshError,
  getProviderLabel,
  hasAgentCatalogRefreshedToday,
  isKnownModelSelectionInCatalog,
} from "@nanoboss/agent-acp";
import {
  createTextPromptInput,
  normalizePromptInput,
  promptInputDisplayText,
} from "@nanoboss/procedure-sdk";

import { formatAgentSelectionLabel } from "./agent-label.ts";
import { getBuildFreshnessNotice } from "./build-freshness.ts";
import { buildModelCommand } from "./model-command.ts";
import {
  formatExtensionsCard,
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
  formatPendingPromptClearStatus,
  getBusyLocalCommandLabel,
  getLocalBusyInputStatus,
  isTerminalFrontendEvent,
  selectNextPendingPrompt,
} from "./controller-input-flow.ts";

import type { TuiExtensionStatus } from "@nanoboss/tui-extension-catalog";

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
  cancelSessionContinuation?: typeof cancelSessionContinuation;
  startSessionEventStream?: (params: {
    baseUrl: string;
    sessionId: string;
    onEvent: (event: FrontendEventEnvelope) => void;
    onError?: (error: unknown) => void;
  }) => SessionStreamHandle;
  discoverAgentCatalog?: typeof discoverAgentCatalog;
  hasAgentCatalogRefreshedToday?: typeof hasAgentCatalogRefreshedToday;
  promptForModelSelection?: (
    currentSelection?: DownstreamAgentSelection,
  ) => Promise<DownstreamAgentSelection | undefined>;
  confirmPersistDefaultAgentSelection?: (
    selection: DownstreamAgentSelection,
  ) => Promise<boolean>;
  persistDefaultAgentSelection?: (selection: DownstreamAgentSelection) => Promise<void> | void;
  /**
   * Snapshot of loaded TUI extensions, used to serve the `/extensions`
   * slash command. Supplied at boot by runTuiCli from the
   * `TuiExtensionRegistry` returned by `bootExtensions`.
   */
  listExtensionEntries?: () => readonly TuiExtensionStatus[];
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
    if (!this.state.sessionId) {
      return;
    }

    if (this.state.inputDisabledReason !== "run") {
      if (!this.state.inputDisabled && this.state.pendingContinuation) {
        await this.handleContinuationCancel();
      }
      return;
    }

    // If no active run is in flight but a continuation is paused, route the
    // soft-stop through the engine-authoritative continuation cancel path so
    // form-esc and ctrl+c share a single terminal transition.
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

  /**
   * Cancels the currently paused continuation via the engine's
   * `requestContinuationCancel` entry point. Does NOT attempt to route the
   * user's input through `resume`; the reducer's existing `run_cancelled`
   * handling (from step 1) will clear `pendingContinuation` and restore the
   * default session.
   */
  async handleContinuationCancel(): Promise<void> {
    const sessionId = this.state.sessionId;
    if (!sessionId || !this.state.pendingContinuation) {
      return;
    }

    try {
      await (this.deps.cancelSessionContinuation ?? cancelSessionContinuation)(
        this.params.serverUrl,
        sessionId,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.dispatch({
        type: "local_status",
        text: `[run] continuation cancel failed: ${message}`,
      });
    }
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
  showLocalCard(opts: {
    key?: string;
    title: string;
    markdown: string;
    severity?: "info" | "warn" | "error";
    dismissible?: boolean;
  }): void {
    this.dispatch({
      type: "local_procedure_panel",
      panelId: `local-${opts.key ?? "anon"}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      rendererId: "nb/card@1",
      payload: {
        kind: "notice",
        title: opts.title,
        markdown: opts.markdown,
      },
      severity: opts.severity ?? "info",
      dismissible: opts.dismissible ?? true,
      ...(opts.key !== undefined ? { key: opts.key } : {}),
    });
  }

  private emitExtensionsList(): void {
    const provider = this.deps.listExtensionEntries;
    if (!provider) {
      this.showLocalCard({
        key: "local:extensions",
        title: "Extensions",
        markdown: "Extension registry is not available.",
        severity: "error",
      });
      return;
    }
    const card = formatExtensionsCard(provider());
    this.showLocalCard({
      key: "local:extensions",
      title: card.title,
      markdown: card.markdown,
      severity: card.severity,
    });
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
    if (!selection.model) {
      return undefined;
    }

    const refreshedToday = (this.deps.hasAgentCatalogRefreshedToday ?? hasAgentCatalogRefreshedToday)(
      selection.provider,
      {
        config: { cwd: this.cwd },
      },
    );
    const discoverCatalog = async () => await (this.deps.discoverAgentCatalog ?? discoverAgentCatalog)(
      selection.provider,
      {
        config: { cwd: this.cwd },
        ...(refreshedToday ? {} : { forceRefresh: true }),
      },
    );

    try {
      const catalog = refreshedToday
        ? await discoverCatalog()
        : await this.withLocalBusy(
            `[model] refreshing ${getProviderLabel(selection.provider)} model cache…`,
            discoverCatalog,
          );
      return isKnownModelSelectionInCatalog(catalog, selection.model)
        ? selection
        : undefined;
    } catch (error) {
      this.showLocalCard({
        key: "local:model",
        title: "Model",
        markdown: formatAgentCatalogRefreshError(selection.provider, error),
        severity: "error",
      });
      return undefined;
    }
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
      this.showLocalCard({
        key: "local:model",
        title: "Model",
        markdown: `Saved **${formatAgentSelectionLabel(selection)}** as the default for future runs.`,
        severity: "info",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.showLocalCard({
        key: "local:model",
        title: "Model",
        markdown: `Failed to save default: ${message}`,
        severity: "error",
      });
    }
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
