import { NanobossTuiController } from "./controller.ts";

import {
  CombinedAutocompleteProvider,
  Editor,
  ProcessTerminal,
  TUI,
  matchesKey,
} from "./pi-tui.ts";
import { promptForModelSelection } from "./overlays/model-picker.ts";
import type { UiState } from "./state.ts";
import { createNanobossTuiTheme } from "./theme.ts";
import { NanobossAppView } from "./views.ts";

export interface NanobossTuiAppParams {
  cwd?: string;
  serverUrl: string;
  showToolCalls: boolean;
  sessionId?: string;
}

export class NanobossTuiApp {
  private readonly cwd: string;
  private readonly theme = createNanobossTuiTheme();
  private readonly terminal = new ProcessTerminal();
  private readonly tui = new TUI(this.terminal, true);
  private readonly editor = new Editor(this.tui, this.theme.editor, {
    paddingX: 1,
    autocompleteMaxVisible: 8,
  });
  private readonly view: NanobossAppView;
  private readonly controller: NanobossTuiController;
  private state: UiState;
  private autocompleteSignature = "";
  private stopped = false;

  constructor(private readonly params: NanobossTuiAppParams) {
    this.cwd = params.cwd ?? process.cwd();
    this.controller = new NanobossTuiController(params, {
      promptForModelSelection: async (currentSelection) => {
        const selection = await promptForModelSelection(this.tui, this.theme, currentSelection);
        this.tui.setFocus(this.editor);
        this.tui.requestRender(true);
        return selection;
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
    });
    this.state = this.controller.getState();
    this.view = new NanobossAppView(this.editor, this.theme, this.state);

    this.editor.onSubmit = (text) => {
      void this.controller.handleSubmit(text);
    };

    this.tui.addInputListener((data) => {
      if (!matchesKey(data, "ctrl+c")) {
        return undefined;
      }

      this.editor.setText("");
      this.controller.requestExit();
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

    try {
      return await this.controller.run();
    } finally {
      await this.stop();
    }
  }

  private syncState(state: UiState): void {
    this.state = state;
    this.editor.disableSubmit = this.state.inputDisabled;
    this.refreshAutocompleteProvider();
    this.view.setState(this.state);
    this.tui.requestRender();
  }

  private refreshAutocompleteProvider(): void {
    const signature = this.state.availableCommands.join("\n");
    if (signature === this.autocompleteSignature) {
      return;
    }

    this.autocompleteSignature = signature;
    this.editor.setAutocompleteProvider(
      new CombinedAutocompleteProvider(
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
    await this.controller.stop();

    try {
      await this.terminal.drainInput(100, 20);
    } catch {
      // Ignore drain failures during shutdown.
    }

    this.tui.stop();
  }
}
