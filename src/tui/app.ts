import { writePersistedDefaultAgentSelection } from "../core/settings.ts";

import {
  NanobossTuiController,
  type NanobossTuiControllerDeps,
} from "./controller.ts";
import { shouldDisableEditorSubmit } from "./commands.ts";

import {
  type AutocompleteItem,
  CombinedAutocompleteProvider,
  Editor,
  ProcessTerminal,
  TUI,
  isKeyRelease,
  matchesKey,
} from "./pi-tui.ts";
import { promptForModelSelection, promptToPersistModelSelection } from "./overlays/model-picker.ts";
import type { UiState } from "./state.ts";
import { createNanobossTuiTheme, type NanobossTuiTheme } from "./theme.ts";
import { NanobossAppView } from "./views.ts";

export interface NanobossTuiAppParams {
  cwd?: string;
  serverUrl: string;
  showToolCalls: boolean;
  sessionId?: string;
}

interface EditorLike {
  onSubmit?: (text: string) => void;
  onChange?: (text: string) => void;
  disableSubmit: boolean;
  addToHistory(text: string): void;
  setText(text: string): void;
  getText(): string;
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
}

interface ControllerLike {
  getState(): UiState;
  handleSubmit(text: string): Promise<void>;
  queuePrompt(text: string): Promise<void>;
  cancelActiveRun(): Promise<void>;
  toggleToolOutput(): void;
  requestExit(): void;
  run(): Promise<string | undefined>;
  stop(): Promise<void>;
}

export interface NanobossTuiAppDeps {
  createTheme?: () => NanobossTuiTheme;
  createTerminal?: () => TerminalLike;
  createTui?: (terminal: TerminalLike) => TuiLike;
  createEditor?: (tui: TuiLike, theme: NanobossTuiTheme) => EditorLike;
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
  private readonly now: () => number;
  private state: UiState;
  private autocompleteSignature = "";
  private stopped = false;
  private liveRefreshInterval?: ReturnType<typeof setInterval>;
  private lastToolOutputToggleAt = Number.NEGATIVE_INFINITY;
  private lastCtrlCAt = Number.NEGATIVE_INFINITY;

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

    const controllerDeps: NanobossTuiControllerDeps = {
      promptForModelSelection: async (currentSelection) => {
        const selection = await promptForModelSelection(this.tui, this.theme, currentSelection);
        this.tui.setFocus(this.editor);
        this.tui.requestRender(true);
        return selection;
      },
      confirmPersistDefaultAgentSelection: async (selection) => {
        const shouldPersist = await promptToPersistModelSelection(this.tui, this.theme, selection);
        this.tui.setFocus(this.editor);
        this.tui.requestRender(true);
        return shouldPersist;
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
        this.editor.setText("");
      },
    };
    this.controller = deps.createController?.(params, controllerDeps) ?? new NanobossTuiController(params, controllerDeps);
    this.state = this.controller.getState();
    this.view = deps.createView?.(this.editor, this.theme, this.state) ?? new NanobossAppView(this.editor as Editor, this.theme, this.state);

    this.editor.onSubmit = (text) => {
      void this.controller.handleSubmit(text);
    };
    this.editor.onChange = () => {
      this.updateEditorSubmitState();
    };

    this.tui.addInputListener((data) => {
      if (isKeyRelease(data)) {
        return undefined;
      }

      if (matchesKey(data, "tab") && this.state.inputDisabled) {
        const text = this.editor.getText();
        if (text.trim().length === 0) {
          return undefined;
        }

        void this.controller.queuePrompt(text);
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
    this.state = state;
    this.updateEditorSubmitState();
    this.refreshAutocompleteProvider();
    this.view.setState(this.state);
    this.tui.requestRender();
  }

  private updateEditorSubmitState(): void {
    this.editor.disableSubmit = shouldDisableEditorSubmit(this.state.inputDisabled, this.editor.getText());
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

      this.view.setState(this.state);
      this.tui.requestRender();
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
