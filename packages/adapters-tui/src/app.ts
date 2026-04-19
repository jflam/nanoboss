import {
  createTextPromptInput,
  type PromptInput,
} from "@nanoboss/procedure-sdk";
import type {
  DownstreamAgentProvider,
  DownstreamAgentSelection,
  Simplify2CheckpointContinuationUi,
  Simplify2CheckpointContinuationUiAction,
  Simplify2FocusPickerContinuationUi,
} from "@nanoboss/contracts";
import { writePersistedDefaultAgentSelection } from "@nanoboss/store";
import { createClipboardImageProvider, type ClipboardImageProvider } from "./clipboard/provider.ts";
import {
  attachClipboardImage,
  buildPromptInputFromComposer,
  clearComposerState,
  findImageTokenRangeAtCursor,
  type ComposerImageRecord,
  type ComposerState,
  createComposerState,
  reconcileComposerState,
} from "./composer.ts";

import {
  NanobossTuiController,
  type NanobossTuiControllerDeps,
} from "./controller.ts";
import { shouldDisableEditorSubmit } from "./commands.ts";

import {
  discoverAgentCatalog,
  formatAgentCatalogRefreshError,
  getProviderLabel,
  listKnownProviders,
  listSelectableModelOptionsFromCatalog,
} from "@nanoboss/agent-acp";
import {
  type AutocompleteItem,
  CombinedAutocompleteProvider,
  Editor,
  ProcessTerminal,
  TUI,
  isKeyRelease,
  matchesKey,
} from "./pi-tui.ts";
import { SelectOverlay, type SelectOverlayOptions } from "./overlays/select-overlay.ts";
import { Simplify2ContinuationOverlay } from "./overlays/simplify2-continuation-overlay.ts";
import {
  Simplify2FocusPickerOverlay,
  type Simplify2FocusPickerOverlayAction,
} from "./overlays/simplify2-focus-picker-overlay.ts";
import type { UiState } from "./state.ts";
import { createNanobossTuiTheme, type NanobossTuiTheme } from "./theme.ts";
import { NanobossAppView } from "./views.ts";
import type { ClipboardImage } from "./composer.ts";

type FrontendContinuation = NonNullable<UiState["pendingContinuation"]>;

export interface NanobossTuiAppParams {
  cwd?: string;
  serverUrl: string;
  showToolCalls: boolean;
  sessionId?: string;
  simplify2AutoApprove?: boolean;
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
  toggleToolOutput(): void;
  toggleSimplify2AutoApprove(): void;
  showStatus(text: string): void;
  requestExit(): void;
  run(): Promise<string | undefined>;
  stop(): Promise<void>;
}

interface NanobossTuiAppDeps {
  discoverAgentCatalog?: typeof discoverAgentCatalog;
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

type FrontendSimplify2CheckpointContinuation = FrontendContinuation & {
  ui: Simplify2CheckpointContinuationUi;
};

type FrontendSimplify2FocusPickerContinuation = FrontendContinuation & {
  ui: Simplify2FocusPickerContinuationUi;
};

const TOOL_OUTPUT_TOGGLE_COOLDOWN_MS = 150;
const CTRL_C_EXIT_WINDOW_MS = 500;

class NanobossAutocompleteProvider extends CombinedAutocompleteProvider {
  override applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): {
    lines: string[];
    cursorLine: number;
    cursorCol: number;
  } {
    if (prefix.startsWith("/")) {
      const currentLine = lines[cursorLine] ?? "";
      const beforePrefix = currentLine.slice(0, cursorCol - prefix.length);
      if (beforePrefix.trim() === "") {
        const completedLines = [...lines];
        completedLines[cursorLine] = `${beforePrefix}/${item.value} ${currentLine.slice(cursorCol)}`;
        return {
          lines: completedLines,
          cursorLine,
          cursorCol: beforePrefix.length + item.value.length + 2,
        };
      }
    }

    return super.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
  }
}

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

      if (matchesKey(data, "tab") && this.state.inputDisabled) {
        if (this.editor.isShowingAutocomplete()) {
          return undefined;
        }

        const text = this.editor.getText();
        if (text.trim().length === 0) {
          return undefined;
        }

        const promptInput = buildPromptInputForSubmit(
          this.composerState,
          text,
          this.clearedComposerStateSnapshot,
        );
        this.clearedComposerStateSnapshot = undefined;
        void this.controller.queuePrompt(promptInput);
        return { consume: true };
      }

      if (matchesKey(data, "escape") && this.state.inputDisabled) {
        void this.controller.cancelActiveRun();
        return { consume: true };
      }

      if (matchesKey(data, "ctrl+o")) {
        const now = this.now();
        if (now - this.lastToolOutputToggleAt >= TOOL_OUTPUT_TOGGLE_COOLDOWN_MS) {
          this.lastToolOutputToggleAt = now;
          this.controller.toggleToolOutput();
        }
        return { consume: true };
      }

      if (matchesKey(data, "ctrl+g")) {
        this.controller.toggleSimplify2AutoApprove();
        return { consume: true };
      }

      if (matchesKey(data, "ctrl+p")) {
        this.toggleLiveUpdatesPaused();
        return { consume: true };
      }

      if (matchesKey(data, "backspace") && this.handleImageTokenDeletion("backspace")) {
        return { consume: true };
      }

      if (matchesKey(data, "delete") && this.handleImageTokenDeletion("delete")) {
        return { consume: true };
      }

      if (matchesKey(data, "ctrl+v")) {
        void this.handleCtrlVImagePaste();
        return { consume: true };
      }

      if (!matchesKey(data, "ctrl+c")) {
        return undefined;
      }

      this.handleCtrlC();
      return { consume: true };
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
    this.editor.disableSubmit = shouldDisableEditorSubmit(this.state.inputDisabled, this.editor.getText());
  }

  private async handleCtrlVImagePaste(): Promise<void> {
    this.controller.showStatus("[clipboard] ctrl+v received");
    const image = await this.clipboardImageProvider.readImage();
    if (!image) {
      this.controller.showStatus("[clipboard] ctrl+v received, but no image was readable from the clipboard");
      return;
    }

    const record = attachClipboardImage(this.composerState, image);
    if (this.editor.insertTextAtCursor) {
      this.editor.insertTextAtCursor(record.token);
    } else {
      this.editor.setText(`${this.editor.getText()}${record.token}`);
    }
    this.controller.showStatus(`[clipboard] attached ${record.token}`);
  }

  private handleImageTokenDeletion(direction: "backspace" | "delete"): boolean {
    const text = this.editor.getText();
    if (text.length === 0 || this.composerState.imagesByToken.size === 0) {
      return false;
    }

    const cursor = this.editor.getCursor?.();
    if (!cursor) {
      return false;
    }

    const cursorIndex = cursorToTextIndex(text, cursor);
    const match = findImageTokenRangeAtCursor(this.composerState, text, cursorIndex, direction);
    if (!match) {
      return false;
    }

    this.composerState.imagesByToken.delete(match.token);
    const nextText = `${text.slice(0, match.start)}${text.slice(match.end)}`;
    applyEditorTextAndCursor(this.editor, nextText, match.start);
    this.controller.showStatus(`[clipboard] removed ${match.token}`);
    return true;
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
    const provider = await this.promptWithInlineSelect<DownstreamAgentProvider>({
      title: "Choose an agent",
      items: listKnownProviders().map((value) => ({
        value,
        label: getProviderLabel(value),
      })),
      initialValue: currentSelection?.provider,
      footer: "↑↓ navigate • enter select • esc cancel",
    });
    if (!provider) {
      return undefined;
    }

    let catalog: Awaited<ReturnType<typeof discoverAgentCatalog>>;
    try {
      catalog = await (this.deps.discoverAgentCatalog ?? discoverAgentCatalog)(provider, {
        config: { cwd: this.cwd },
      });
    } catch (error) {
      throw new Error(formatAgentCatalogRefreshError(provider, error));
    }

    const items = listSelectableModelOptionsFromCatalog(catalog).map((option) => ({
      value: option.value,
      label: option.label,
      description: option.description,
    }));
    if (items.length === 0) {
      throw new Error(`${provider} harness did not advertise any models`);
    }

    const model = await this.promptWithInlineSelect<string>({
      title: `Choose a ${catalog.label} model`,
      items,
      initialValue: currentSelection?.provider === provider ? currentSelection.model : undefined,
      selectedDetailTitle: "Details",
      renderSelectedDetail: (item) => item.description ?? "",
      footer: "↑↓ navigate • enter select • esc cancel",
    });
    if (!model) {
      return undefined;
    }

    return {
      provider,
      model,
    };
  }

  private async promptToPersistInlineModelSelection(
    selection: DownstreamAgentSelection,
  ): Promise<boolean> {
    const decision = await this.promptWithInlineSelect<"no" | "yes">({
      title: `Make ${selection.provider}/${selection.model ?? "default"} the default for future runs?`,
      items: [
        {
          value: "no",
          label: "No",
          description: "Keep this model change in the current session only",
        },
        {
          value: "yes",
          label: "Yes",
          description: "Persist this choice for future nanoboss runs",
        },
      ],
      initialValue: "no",
      selectedDetailTitle: "Choice",
      renderSelectedDetail: (item) => item.description ?? "",
      footer: "↑↓ choose • enter confirm • esc keep No",
      maxVisible: 4,
    });

    return decision === "yes";
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
    const continuation = getSimplify2Continuation(this.state.pendingContinuation);
    const signature = continuation ? buildSimplify2ContinuationSignature(continuation) : undefined;
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
      if (isSimplify2CheckpointContinuation(continuation)) {
        this.showSimplify2ContinuationOverlay(continuation, signature);
      } else {
        this.showSimplify2FocusPickerOverlay(continuation, signature);
      }
      return;
    }

    if (!shouldShow && this.inlineComposerMode === "simplify2") {
      this.restoreEditorComposer();
    }
  }

  private showSimplify2ContinuationOverlay(
    continuation: FrontendSimplify2CheckpointContinuation,
    signature: string,
  ): void {
    this.inlineComposerMode = "simplify2";
    this.openSimplify2ContinuationSignature = signature;
    const component = new Simplify2ContinuationOverlay(
      this.tui as TUI,
      this.theme,
      continuation.ui.title,
      continuation.ui.actions,
      (action) => {
        this.handleSimplify2ContinuationAction(action);
      },
    );
    this.view.showComposer(component);
    this.tui.setFocus(component);
    this.requestRender(true);
  }

  private showSimplify2FocusPickerOverlay(
    continuation: FrontendSimplify2FocusPickerContinuation,
    signature: string,
  ): void {
    this.inlineComposerMode = "simplify2";
    this.openSimplify2ContinuationSignature = signature;
    const component = new Simplify2FocusPickerOverlay(
      this.tui as TUI,
      this.theme,
      continuation.ui.title,
      continuation.ui.entries,
      (action) => {
        this.handleSimplify2FocusPickerAction(action);
      },
    );
    this.view.showComposer(component);
    this.tui.setFocus(component);
    this.requestRender(true);
  }

  private handleSimplify2ContinuationAction(action: Simplify2CheckpointContinuationUiAction | undefined): void {
    const signature = this.openSimplify2ContinuationSignature;
    this.restoreEditorComposer();
    if (!action || action.id === "other") {
      if (signature) {
        this.dismissedSimplify2ContinuationSignature = signature;
      }
      return;
    }

    if (action.reply) {
      void this.controller.handleSubmit(createTextPromptInput(action.reply));
    }
  }

  private handleSimplify2FocusPickerAction(action: Simplify2FocusPickerOverlayAction): void {
    const signature = this.openSimplify2ContinuationSignature;
    this.restoreEditorComposer();
    if (action.kind === "cancel") {
      if (signature) {
        this.dismissedSimplify2ContinuationSignature = signature;
      }
      return;
    }

    if (action.kind === "new") {
      this.editor.setText("new ");
      if (signature) {
        this.dismissedSimplify2ContinuationSignature = signature;
      }
      return;
    }

    const command = action.kind === "archive"
      ? `archive ${action.focusId}`
      : `continue ${action.focusId}`;
    void this.controller.handleSubmit(createTextPromptInput(command));
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

function buildPromptInputForSubmit(
  composerState: ComposerState,
  text: string,
  clearedSnapshot?: ComposerState,
): PromptInput {
  const promptInput = buildPromptInputFromComposer(composerState, text);
  if (promptInput.parts.some((part) => part.type === "image") || !clearedSnapshot) {
    return promptInput;
  }

  return buildPromptInputFromComposer(clearedSnapshot, text);
}

function cloneComposerState(state: ComposerState): ComposerState {
  return {
    nextImageNumber: state.nextImageNumber,
    imagesByToken: new Map<string, ComposerImageRecord>(state.imagesByToken),
  };
}

function applyEditorTextAndCursor(editor: EditorLike, text: string, cursorIndex: number): void {
  editor.setText(text);
  const targetCursor = textIndexToCursor(text, cursorIndex);
  if (editor.setCursor) {
    editor.setCursor(targetCursor.line, targetCursor.col);
    return;
  }

  const editorImpl = editor as EditorLike & {
    state?: { cursorLine: number; cursorCol: number };
    setCursorCol?: (col: number) => void;
  };
  if (!editorImpl.state) {
    return;
  }

  editorImpl.state.cursorLine = targetCursor.line;
  if (typeof editorImpl.setCursorCol === "function") {
    editorImpl.setCursorCol(targetCursor.col);
  } else {
    editorImpl.state.cursorCol = targetCursor.col;
  }
}

function cursorToTextIndex(text: string, cursor: { line: number; col: number }): number {
  const lines = text.split("\n");
  let index = 0;

  for (let lineIndex = 0; lineIndex < cursor.line; lineIndex += 1) {
    index += (lines[lineIndex] ?? "").length + 1;
  }

  return index + cursor.col;
}

function textIndexToCursor(text: string, index: number): { line: number; col: number } {
  const clampedIndex = Math.max(0, Math.min(index, text.length));
  const before = text.slice(0, clampedIndex);
  const lines = before.split("\n");
  const line = Math.max(0, lines.length - 1);
  const col = (lines.at(-1) ?? "").length;
  return { line, col };
}

function getSimplify2Continuation(
  continuation: FrontendContinuation | undefined,
): FrontendSimplify2CheckpointContinuation | FrontendSimplify2FocusPickerContinuation | undefined {
  if (
    !continuation
    || continuation.procedure !== "simplify2"
    || (
      continuation.ui?.kind !== "simplify2_checkpoint"
      && continuation.ui?.kind !== "simplify2_focus_picker"
    )
  ) {
    return undefined;
  }

  return continuation.ui.kind === "simplify2_checkpoint"
    ? continuation as FrontendSimplify2CheckpointContinuation
    : continuation as FrontendSimplify2FocusPickerContinuation;
}

function isSimplify2CheckpointContinuation(
  continuation: FrontendSimplify2CheckpointContinuation | FrontendSimplify2FocusPickerContinuation,
): continuation is FrontendSimplify2CheckpointContinuation {
  return continuation.ui.kind === "simplify2_checkpoint";
}

function buildSimplify2ContinuationSignature(
  continuation: FrontendContinuation,
): string {
  return JSON.stringify({
    procedure: continuation.procedure,
    question: continuation.question,
    inputHint: continuation.inputHint,
    suggestedReplies: continuation.suggestedReplies,
    ui: continuation.ui,
  });
}
