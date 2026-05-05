import type { SessionStreamHandle } from "@nanoboss/adapters-http";
import type { PromptInput } from "@nanoboss/contracts";

import { reduceUiState } from "../reducer/reducer.ts";
import type { UiAction } from "../reducer/reducer-actions.ts";
import { type UiPendingPrompt, type UiState } from "../state/state.ts";
import {
  handleBusyPromptInput,
} from "./controller-input-flow.ts";
import {
  buildExtensionsLocalCard,
  createLocalCardAction,
  type ControllerLocalCardOptions,
} from "./controller-local-cards.ts";
import {
  openModelPicker as openModelPickerInternal,
} from "./controller-model-selection.ts";
import {
  createAndApplyControllerSession,
} from "./controller-session.ts";
import { runControllerSession } from "./controller-run.ts";
import {
  cancelActiveRun as cancelActiveRunInternal,
  handleContinuationCancel as handleContinuationCancelInternal,
  maybeSendLatchedStopRequest as maybeSendLatchedStopRequestInternal,
  sendStopRequest as sendStopRequestInternal,
} from "./controller-stop.ts";
import {
  forwardPrompt as forwardPromptInternal,
} from "./controller-prompt-flow.ts";
import { toggleSessionAutoApprove as toggleSessionAutoApproveInternal } from "./controller-auto-approve.ts";
import {
  handleControllerSubmit,
  queueControllerPrompt,
} from "./controller-submit.ts";
import { createControllerInitialState } from "./controller-initial-state.ts";
import {
  createControllerExitSignal,
  requestControllerExit,
  stopControllerLifecycle,
} from "./controller-lifecycle.ts";
import { applyControllerSessionEventStream } from "./controller-session-events.ts";
import { enqueueControllerPendingPrompt } from "./controller-pending-prompts.ts";
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
  private readonly exitResolver: () => void;
  private readonly exited: Promise<void>;

  constructor(
    private readonly params: NanobossTuiControllerParams,
    private readonly deps: NanobossTuiControllerDeps = {},
  ) {
    this.cwd = params.cwd ?? process.cwd();
    this.state = createControllerInitialState({
      cwd: this.cwd,
      showToolCalls: params.showToolCalls,
      simplify2AutoApprove: params.simplify2AutoApprove,
    });
    const exitSignal = createControllerExitSignal();
    this.exited = exitSignal.exited;
    this.exitResolver = exitSignal.resolve;
  }

  getState(): UiState {
    return this.state;
  }

  async run(): Promise<string | undefined> {
    return await runControllerSession({
      deps: this.deps,
      serverUrl: this.params.serverUrl,
      cwd: this.cwd,
      sessionId: this.params.sessionId,
      simplify2AutoApprove: this.params.simplify2AutoApprove,
      exited: this.exited,
      getCurrentSessionId: () => this.state.sessionId,
      onStatus: (text) => {
        this.dispatch({ type: "local_status", text });
      },
      applySession: async (session) => await this.applySession(session),
      showLocalCard: (opts) => this.showLocalCard(opts),
      stop: async () => await this.stop(),
    });
  }

  async handleSubmit(input: string | PromptInput): Promise<void> {
    await handleControllerSubmit({
      input,
      cwd: this.cwd,
      deps: this.deps,
      getState: () => this.state,
      requestExit: () => this.requestExit(),
      dispatch: (action) => this.dispatch(action),
      showLocalCard: (opts) => this.showLocalCard(opts),
      handleBusyPromptInput: async (promptInput, text, trimmed, kind) =>
        await this.handleBusyPromptInput(promptInput, text, trimmed, kind),
      createNewSession: async () => await this.createNewSession(),
      emitExtensionsList: () => this.emitExtensionsList(),
      openModelPicker: async () => await this.openModelPicker(),
      withLocalBusy: async (status, work) => await this.withLocalBusy(status, work),
      forwardPrompt: async (prompt) => await this.forwardPrompt(prompt),
    });
  }

  async queuePrompt(input: string | PromptInput): Promise<void> {
    await queueControllerPrompt({
      input,
      getState: () => this.state,
      handleBusyPromptInput: async (promptInput, text, trimmed, kind) =>
        await this.handleBusyPromptInput(promptInput, text, trimmed, kind),
    });
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

  showLocalCard(opts: ControllerLocalCardOptions): void {
    this.dispatch(createLocalCardAction(opts));
  }

  private emitExtensionsList(): void {
    this.showLocalCard(buildExtensionsLocalCard(this.deps.listExtensionEntries));
  }

  requestExit(): void {
    requestControllerExit({
      stopped: this.stopped,
      onExit: this.deps.onExit,
      resolveExit: this.exitResolver,
    });
  }

  async stop(): Promise<void> {
    this.stream = await stopControllerLifecycle({
      stopped: this.stopped,
      stream: this.stream,
      setStopped: (stopped) => {
        this.stopped = stopped;
      },
    });
  }

  private dispatch(action: UiAction): void {
    this.state = reduceUiState(this.state, action);
    this.deps.onStateChange?.(this.state);
  }

  private async applySession(session: SessionResponse): Promise<void> {
    this.stream = await applyControllerSessionEventStream({
      deps: this.deps,
      serverUrl: this.params.serverUrl,
      stream: this.stream,
      session,
      dispatch: (action) => this.dispatch(action),
      getState: () => this.state,
      sendStopRequest: async (runId) => await this.sendStopRequest(runId),
      getFlushingPendingPrompt: () => this.flushingPendingPrompt,
      setFlushingPendingPrompt: (flushing) => {
        this.flushingPendingPrompt = flushing;
      },
      forwardPrompt: async (prompt) => await this.forwardPrompt(prompt),
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
    this.nextPendingPromptId = await enqueueControllerPendingPrompt({
      promptInput,
      kind,
      nextPendingPromptId: this.nextPendingPromptId,
      dispatch: (action) => this.dispatch(action),
      cancelActiveRun: async () => await this.cancelActiveRun(),
    });
  }

  private async handleBusyPromptInput(
    promptInput: PromptInput,
    text: string,
    trimmed: string,
    kind: UiPendingPrompt["kind"],
  ): Promise<boolean> {
    return await handleBusyPromptInput({
      state: this.state,
      trimmed,
      text,
      promptInput,
      kind,
      dispatch: (action) => this.dispatch(action),
      onAddHistory: this.deps.onAddHistory,
      onClearInput: this.deps.onClearInput,
      enqueuePendingPrompt: async (nextPromptInput, nextKind) =>
        await this.enqueuePendingPrompt(nextPromptInput, nextKind),
    });
  }

  private async createNewSession(): Promise<void> {
    await createAndApplyControllerSession({
      deps: this.deps,
      serverUrl: this.params.serverUrl,
      cwd: this.cwd,
      state: this.state,
      dispatch: (action) => this.dispatch(action),
      applySession: async (session) => await this.applySession(session),
      showLocalCard: (opts) => this.showLocalCard(opts),
    });
  }

  private async openModelPicker(): Promise<void> {
    this.deps.onClearInput?.();
    await openModelPickerInternal({
      currentSelection: this.state.defaultAgentSelection,
      deps: this.deps,
      withLocalBusy: async (status, work) => await this.withLocalBusy(status, work),
      showLocalCard: (opts) => this.showLocalCard(opts),
      dispatch: (action) => this.dispatch(action),
      onAddHistory: this.deps.onAddHistory,
      forwardPrompt: async (prompt) => await this.forwardPrompt(prompt),
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
    await toggleSessionAutoApproveInternal({
      deps: this.deps,
      serverUrl: this.params.serverUrl,
      state: this.state,
      dispatch: (action) => this.dispatch(action),
    });
  }
}
