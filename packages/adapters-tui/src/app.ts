import {
  createTextPromptInput,
  type PromptInput,
} from "@nanoboss/procedure-sdk";
import type {
  DownstreamAgentSelection,
} from "@nanoboss/contracts";
import { writePersistedDefaultAgentSelection } from "@nanoboss/store";
import { createClipboardImageProvider, type ClipboardImageProvider } from "./clipboard/provider.ts";
import {
  clearComposerState,
  type ComposerState,
  createComposerState,
  reconcileComposerState,
} from "./composer.ts";
import {
  buildPromptInputForSubmit,
  cloneComposerState,
} from "./app-composer.ts";
import {
  handleCtrlVImagePaste as handleCtrlVImagePasteInternal,
  handleImageTokenDeletion as handleImageTokenDeletionInternal,
} from "./app-clipboard.ts";
import {
  buildContinuationFormSignature,
  getFormContinuation,
  type FrontendContinuationWithFormId,
} from "./app-continuation-form.ts";

import {
  NanobossTuiController,
  type NanobossTuiControllerDeps,
} from "./controller.ts";
import { shouldDisableEditorSubmit } from "./commands.ts";
import type { TuiExtensionStatus } from "@nanoboss/tui-extension-catalog";

import {
  Editor,
  ProcessTerminal,
  TUI,
  isKeyRelease,
  matchesKey,
} from "./pi-tui.ts";
import { NanobossAutocompleteProvider } from "./app-autocomplete.ts";
import { createAppBindingHooks as createAppBindingHooksInternal } from "./app-binding-hooks.ts";
import { dispatchKeyBinding, type BindingCtx } from "./bindings.ts";
// Side-effect import: registers the core keybindings into the module-level
// registry so dispatchKeyBinding() resolves them without the caller having
// to wire individual handlers.
import "./core-bindings.ts";
// Side-effect import: registers the core form renderers into the
// module-level FormRenderer registry so getFormRenderer(...) resolves
// nb/simplify2-checkpoint@1 and nb/simplify2-focus-picker@1 without
// the caller having to wire individual handlers.
import "./core-form-renderers.ts";
import { SelectOverlay, type SelectOverlayOptions } from "./overlays/select-overlay.ts";
import { getFormRenderer, type FormRenderContext } from "./form-renderers.ts";
import type { UiState } from "./state.ts";
import { createNanobossTuiTheme, type NanobossTuiTheme } from "./theme.ts";
import { NanobossAppView } from "./views.ts";
import {
  promptForInlineModelSelection as promptForInlineModelSelectionInternal,
  promptToPersistInlineModelSelection as promptToPersistInlineModelSelectionInternal,
  type InlineModelSelectionDeps,
} from "./app-model-selection.ts";

export interface NanobossTuiAppParams {
  cwd?: string;
  serverUrl: string;
  showToolCalls: boolean;
  sessionId?: string;
  simplify2AutoApprove?: boolean;
  /**
   * Snapshot function returning the currently-loaded TUI extensions. Wired
   * by runTuiCli from the registry `bootExtensions` produced; forwarded
   * into the controller so `/extensions` can render its output.
   */
  listExtensionEntries?: () => readonly TuiExtensionStatus[];
}

interface EditorLike {
  onSubmit?: (text: string) => void;
  onChange?: (text: string) => void;
  disableSubmit: boolean;
  addToHistory(text: string): void;
  setText(text: string): void;
  getText(): string;
  getCursor?(): { line: number; col: number };
  setCursor?(line: number, col: number): void;
  insertTextAtCursor?(text: string): void;
  isShowingAutocomplete(): boolean;
  setAutocompleteProvider(provider: unknown): void;
}

interface TerminalLike {
  setTitle(title: string): void;
  drainInput(timeoutMs: number, rounds: number): Promise<void>;
}

interface TuiLike {
  addInputListener(listener: (data: string) => unknown): void;
  addChild(child: unknown): void;
  setFocus(component: unknown): void;
  start(): void;
  requestRender(force?: boolean): void;
  stop(): void;
}

interface ViewLike {
  setState(state: UiState): void;
  showComposer(component: unknown): void;
  showEditor(): void;
}

interface ControllerLike {
  getState(): UiState;
  handleSubmit(text: string | PromptInput): Promise<void>;
  queuePrompt(text: string | PromptInput): Promise<void>;
  cancelActiveRun(): Promise<void>;
  handleContinuationCancel?(): Promise<void>;
  toggleToolOutput(): void;
  toggleToolCardsHidden(): void;
  toggleSimplify2AutoApprove(): void;
  showStatus(text: string): void;
  showLocalCard(opts: {
    key?: string;
    title: string;
    markdown: string;
    severity?: "info" | "warn" | "error";
    dismissible?: boolean;
  }): void;
  requestExit(): void;
  run(): Promise<string | undefined>;
  stop(): Promise<void>;
}

interface NanobossTuiAppDeps {
  discoverAgentCatalog?: InlineModelSelectionDeps["discoverAgentCatalog"];
  hasAgentCatalogRefreshedToday?: InlineModelSelectionDeps["hasAgentCatalogRefreshedToday"];
  createTheme?: () => NanobossTuiTheme;
  createTerminal?: () => TerminalLike;
  createTui?: (terminal: TerminalLike) => TuiLike;
  createEditor?: (tui: TuiLike, theme: NanobossTuiTheme) => EditorLike;
  createClipboardImageProvider?: () => ClipboardImageProvider;
  createController?: (
    params: NanobossTuiAppParams,
    deps: NanobossTuiControllerDeps,
  ) => ControllerLike;
  createView?: (editor: EditorLike, theme: NanobossTuiTheme, state: UiState) => ViewLike;
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
  now?: () => number;
}

const TOOL_OUTPUT_TOGGLE_COOLDOWN_MS = 150;
const CTRL_C_EXIT_WINDOW_MS = 500;

export class NanobossTuiApp {
  private readonly cwd: string;
  private readonly theme: NanobossTuiTheme;
  private readonly terminal: TerminalLike;
  private readonly tui: TuiLike;
  private readonly editor: EditorLike;
  private readonly view: ViewLike;
  private readonly controller: ControllerLike;
  private readonly clipboardImageProvider: ClipboardImageProvider;
  private readonly now: () => number;
  private state: UiState;
  private readonly composerState = createComposerState();
  private clearedComposerStateSnapshot?: ComposerState;
  private autocompleteSignature = "";
  private stopped = false;
  private liveRefreshInterval?: ReturnType<typeof setInterval>;
  private lastToolOutputToggleAt = Number.NEGATIVE_INFINITY;
  private lastCtrlCAt = Number.NEGATIVE_INFINITY;
  private inlineComposerMode: "editor" | "select" | "simplify2" = "editor";
  private openSimplify2ContinuationSignature?: string;
  private lastSeenSimplify2ContinuationSignature?: string;
  private dismissedSimplify2ContinuationSignature?: string;
  private liveUpdatesPaused = false;

  constructor(
    private readonly params: NanobossTuiAppParams,
    private readonly deps: NanobossTuiAppDeps = {},
  ) {
    this.cwd = params.cwd ?? process.cwd();
    this.now = deps.now ?? Date.now;
    this.theme = deps.createTheme?.() ?? createNanobossTuiTheme();
    this.terminal = deps.createTerminal?.() ?? new ProcessTerminal();
    this.tui = deps.createTui?.(this.terminal) ?? new TUI(this.terminal as ProcessTerminal, false);
    this.editor = deps.createEditor?.(this.tui, this.theme) ?? new Editor(this.tui as TUI, this.theme.editor, {
      paddingX: 1,
      autocompleteMaxVisible: 8,
    });
    this.clipboardImageProvider = deps.createClipboardImageProvider?.() ?? createClipboardImageProvider();

    const controllerDeps: NanobossTuiControllerDeps = {
      promptForModelSelection: async (currentSelection) => {
        return await this.promptForInlineModelSelection(currentSelection);
      },
      confirmPersistDefaultAgentSelection: async (selection) => {
        return await this.promptToPersistInlineModelSelection(selection);
      },
      persistDefaultAgentSelection: (selection) => {
        writePersistedDefaultAgentSelection(selection);
      },
      listExtensionEntries: params.listExtensionEntries,
      onStateChange: (state) => {
        this.syncState(state);
      },
      onAddHistory: (text) => {
        this.editor.addToHistory(text);
      },
      onClearInput: () => {
        clearComposerState(this.composerState);
        this.editor.setText("");
      },
    };
    this.controller = deps.createController?.(params, controllerDeps) ?? new NanobossTuiController(params, controllerDeps);
    this.state = this.controller.getState();
    this.view = deps.createView?.(this.editor, this.theme, this.state) ?? new NanobossAppView(this.editor as Editor, this.theme, this.state);

    this.editor.onSubmit = (text) => {
      const promptInput = buildPromptInputForSubmit(
        this.composerState,
        text,
        this.clearedComposerStateSnapshot,
      );
      this.clearedComposerStateSnapshot = undefined;
      void this.controller.handleSubmit(promptInput);
    };
    this.editor.onChange = (text) => {
      if (text.length === 0 && this.composerState.imagesByToken.size > 0) {
        this.clearedComposerStateSnapshot = cloneComposerState(this.composerState);
      } else if (text.length > 0) {
        this.clearedComposerStateSnapshot = undefined;
      }
      reconcileComposerState(this.composerState, text);
      this.updateEditorSubmitState();
    };

    this.tui.addInputListener((data) => {
      if (isKeyRelease(data)) {
        return undefined;
      }

      // Editor-local pre-step: backspace/delete image-token removal
      // depends on cursor state and the composer's image token map,
      // neither of which is surfaced through BindingCtx. Keep this
      // handler ahead of the registry dispatch so a successful token
      // deletion consumes the key before the registry sees it.
      if (matchesKey(data, "backspace") && this.handleImageTokenDeletion("backspace")) {
        return { consume: true };
      }

      if (matchesKey(data, "delete") && this.handleImageTokenDeletion("delete")) {
        return { consume: true };
      }

      const ctx: BindingCtx = {
        controller: this.controller,
        state: this.state,
        editor: {
          getText: () => this.editor.getText(),
          isShowingAutocomplete: () => this.editor.isShowingAutocomplete(),
        },
        app: this.createBindingAppHooks(),
      };

      const result = dispatchKeyBinding(data, ctx);
      if (result && result.consume !== false) {
        return { consume: true };
      }
      return undefined;
    });

    this.tui.addChild(this.view);
    this.tui.setFocus(this.editor);
    this.syncState(this.state);
  }

  async run(): Promise<string | undefined> {
    this.tui.start();
    this.terminal.setTitle("nanoboss");
    this.tui.requestRender(true);
    this.startLiveRefresh();

    try {
      return await this.controller.run();
    } finally {
      await this.stop();
    }
  }

  requestExit(): void {
    this.controller.requestExit();
  }

  /**
   * Surface a one-line status message through the controller's existing
   * status-line pathway. Exposed so callers (e.g. runTuiCli) can flush
   * extension-boot diagnostics collected before the controller existed.
   */
  showStatus(text: string): void {
    this.controller.showStatus(text);
  }

  showLocalCard(opts: {
    key?: string;
    title: string;
    markdown: string;
    severity?: "info" | "warn" | "error";
    dismissible?: boolean;
  }): void {
    this.controller.showLocalCard(opts);
  }

  requestSigintExit(): boolean {
    return this.handleCtrlC();
  }

  private syncState(state: UiState): void {
    if (this.theme.getToolCardMode() !== state.toolCardThemeMode) {
      this.theme.setToolCardMode(state.toolCardThemeMode);
    }
    this.state = { ...state, liveUpdatesPaused: this.liveUpdatesPaused };
    this.updateEditorSubmitState();
    this.refreshAutocompleteProvider();
    this.view.setState(this.state);
    this.syncSimplify2ContinuationComposer();
    this.requestRender();
  }

  private requestRender(force?: boolean): void {
    if (this.liveUpdatesPaused) {
      if (!force) {
        return;
      }
      // A forced render (e.g. user-triggered overlay/composer change) implicitly
      // resumes live updates so the user can see the UI change they just requested.
      this.setLiveUpdatesPaused(false);
      return;
    }
    this.tui.requestRender(force);
  }

  private toggleLiveUpdatesPaused(): void {
    this.setLiveUpdatesPaused(!this.liveUpdatesPaused);
  }

  private setLiveUpdatesPaused(paused: boolean): void {
    if (this.liveUpdatesPaused === paused) {
      return;
    }
    this.liveUpdatesPaused = paused;
    this.state = { ...this.state, liveUpdatesPaused: paused };
    this.view.setState(this.state);
    // Force a single render on every transition: entering pause draws the
    // indicator; leaving pause flushes all updates accumulated while paused.
    this.tui.requestRender(true);
  }

  private updateEditorSubmitState(): void {
    this.editor.disableSubmit = shouldDisableEditorSubmit(
      this.state.inputDisabled,
      this.state.inputDisabledReason,
      this.editor.getText(),
    );
  }

  private async handleCtrlVImagePaste(): Promise<void> {
    await handleCtrlVImagePasteInternal({
      clipboardImageProvider: this.clipboardImageProvider,
      composerState: this.composerState,
      editor: this.editor,
      showClipboardCard: (opts) => this.controller.showLocalCard(opts),
    });
  }

  private handleImageTokenDeletion(direction: "backspace" | "delete"): boolean {
    return handleImageTokenDeletionInternal({
      direction,
      composerState: this.composerState,
      editor: this.editor,
      showClipboardCard: (opts) => this.controller.showLocalCard(opts),
    });
  }

  private handleCtrlC(): boolean {
    const now = this.now();
    if (now - this.lastCtrlCAt < CTRL_C_EXIT_WINDOW_MS) {
      this.controller.requestExit();
      return true;
    }

    this.lastCtrlCAt = now;
    this.editor.setText("");
    return false;
  }

  private refreshAutocompleteProvider(): void {
    const signature = this.state.availableCommands.join("\n");
    if (signature === this.autocompleteSignature) {
      return;
    }

    this.autocompleteSignature = signature;
    this.editor.setAutocompleteProvider(
      new NanobossAutocompleteProvider(
        this.state.availableCommands.map((command) => ({
          value: command.startsWith("/") ? command.slice(1) : command,
          label: command,
        })),
        this.cwd,
      ),
    );
  }

  private async promptForInlineModelSelection(
    currentSelection?: DownstreamAgentSelection,
  ): Promise<DownstreamAgentSelection | undefined> {
    return await promptForInlineModelSelectionInternal({
      cwd: this.cwd,
      currentSelection,
      deps: this.deps,
      showStatus: (text) => this.controller.showStatus(text),
      promptWithInlineSelect: async (options) => await this.promptWithInlineSelect(options),
    });
  }

  private async promptToPersistInlineModelSelection(
    selection: DownstreamAgentSelection,
  ): Promise<boolean> {
    return await promptToPersistInlineModelSelectionInternal({
      selection,
      promptWithInlineSelect: async (options) => await this.promptWithInlineSelect(options),
    });
  }

  private async promptWithInlineSelect<T extends string>(
    options: SelectOverlayOptions<T>,
  ): Promise<T | undefined> {
    return await new Promise<T | undefined>((resolve) => {
      this.inlineComposerMode = "select";
      const component = new SelectOverlay<T>(
        this.tui as TUI,
        this.theme,
        options,
        (value) => {
          this.restoreEditorComposer();
          resolve(value);
        },
      );
      this.view.showComposer(component);
      this.tui.setFocus(component);
      this.requestRender(true);
    });
  }

  private restoreEditorComposer(): void {
    this.inlineComposerMode = "editor";
    this.openSimplify2ContinuationSignature = undefined;
    this.view.showEditor();
    this.tui.setFocus(this.editor);
    this.requestRender(true);
  }

  private syncSimplify2ContinuationComposer(): void {
    const continuation = getFormContinuation(this.state.pendingContinuation);
    const signature = continuation ? buildContinuationFormSignature(continuation) : undefined;
    if (signature !== this.lastSeenSimplify2ContinuationSignature) {
      this.lastSeenSimplify2ContinuationSignature = signature;
      this.dismissedSimplify2ContinuationSignature = undefined;
    }

    const shouldShow = Boolean(
      continuation
      && signature
      && !this.state.simplify2AutoApprove
      && !this.state.inputDisabled
      && this.inlineComposerMode !== "select"
      && this.dismissedSimplify2ContinuationSignature !== signature,
    );

    if (shouldShow && continuation && signature && this.inlineComposerMode !== "simplify2") {
      this.mountContinuationForm(continuation, signature);
      return;
    }

    if (!shouldShow && this.inlineComposerMode === "simplify2") {
      this.restoreEditorComposer();
    }
  }

  private mountContinuationForm(
    continuation: FrontendContinuationWithFormId,
    signature: string,
  ): void {
    const renderer = getFormRenderer(continuation.formId);
    if (!renderer) {
      // Unknown formId: dismiss the inline composer so the user can
      // still type a free-form reply instead of crashing the TUI.
      this.dismissedSimplify2ContinuationSignature = signature;
      return;
    }

    if (!renderer.schema.validate(continuation.formPayload)) {
      // Payload failed typia validation. Treat as unknown/dismissed
      // rather than crashing the TUI; the underlying continuation is
      // still pending and the user can type a reply in the default
      // composer.
      this.dismissedSimplify2ContinuationSignature = signature;
      return;
    }

    this.inlineComposerMode = "simplify2";
    this.openSimplify2ContinuationSignature = signature;

    const ctx: FormRenderContext<unknown> = {
      payload: continuation.formPayload,
      state: this.state,
      theme: this.theme,
      editor: {
        setText: (text: string) => {
          this.editor.setText(text);
        },
        getText: () => this.editor.getText(),
      },
      submit: (reply: string) => {
        this.handleFormSubmit(reply);
      },
      cancel: () => {
        this.handleFormCancel();
      },
    };

    const component = renderer.render(ctx);
    this.view.showComposer(component);
    this.tui.setFocus(component);
    this.requestRender(true);
  }

  private handleFormSubmit(reply: string): void {
    this.restoreEditorComposer();
    void this.controller.handleSubmit(createTextPromptInput(reply));
  }

  private handleFormCancel(): void {
    const signature = this.openSimplify2ContinuationSignature;
    this.restoreEditorComposer();
    if (signature) {
      this.dismissedSimplify2ContinuationSignature = signature;
    }
    void this.controller.handleContinuationCancel?.();
  }

  private createBindingAppHooks() {
    return createAppBindingHooksInternal({
      controller: this.controller,
      editor: this.editor,
      composerState: this.composerState,
      getClearedComposerStateSnapshot: () => this.clearedComposerStateSnapshot,
      clearClearedComposerStateSnapshot: () => {
        this.clearedComposerStateSnapshot = undefined;
      },
      handleCtrlC: () => this.handleCtrlC(),
      handleCtrlVImagePaste: async () => await this.handleCtrlVImagePaste(),
      toggleLiveUpdatesPaused: () => {
        this.toggleLiveUpdatesPaused();
      },
      now: this.now,
      getLastToolOutputToggleAt: () => this.lastToolOutputToggleAt,
      setLastToolOutputToggleAt: (value) => {
        this.lastToolOutputToggleAt = value;
      },
      toolOutputToggleCooldownMs: TOOL_OUTPUT_TOGGLE_COOLDOWN_MS,
    });
  }

  private async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }

    this.stopped = true;
    this.stopLiveRefresh();
    await this.controller.stop();

    try {
      await this.terminal.drainInput(100, 20);
    } catch {
      // Ignore drain failures during shutdown.
    }

    this.tui.stop();
  }

  private startLiveRefresh(): void {
    if (this.liveRefreshInterval) {
      return;
    }

    const setIntervalFn = this.deps.setInterval ?? globalThis.setInterval;
    this.liveRefreshInterval = setIntervalFn(() => {
      if (this.stopped || !this.state.inputDisabled || this.state.runStartedAtMs === undefined) {
        return;
      }

      this.requestRender();
    }, 1_000);
  }

  private stopLiveRefresh(): void {
    if (!this.liveRefreshInterval) {
      return;
    }

    const clearIntervalFn = this.deps.clearInterval ?? globalThis.clearInterval;
    clearIntervalFn(this.liveRefreshInterval);
    this.liveRefreshInterval = undefined;
  }
}
