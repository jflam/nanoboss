import { buildModelCommand } from "../model-command.ts";
import { resolveDownstreamAgentConfig } from "../config.ts";
import { getBuildLabel } from "../build-info.ts";
import { getBuildFreshnessNotice } from "../build-freshness.ts";
import { ensureMatchingHttpServer } from "../http-server-supervisor.ts";
import {
  createHttpSession,
  resumeHttpSession,
  sendSessionPrompt,
  startSessionEventStream,
  type SessionStreamHandle,
} from "../http-client.ts";
import { formatAgentBanner } from "../runtime-banner.ts";
import type { DownstreamAgentSelection } from "../types.ts";

import {
  CombinedAutocompleteProvider,
  Editor,
  ProcessTerminal,
  TUI,
  matchesKey,
} from "./pi-tui.ts";
import { promptForModelSelection } from "./overlays/model-picker.ts";
import { isExitRequest, isModelPickerRequest, isNewSessionRequest, parseModelSelectionCommand } from "./commands.ts";
import { reduceUiState } from "./reducer.ts";
import { createInitialUiState, type UiState } from "./state.ts";
import { createNanobossTuiTheme } from "./theme.ts";
import { NanobossAppView } from "./views.ts";

interface SessionResponse {
  sessionId: string;
  cwd: string;
  commands: Array<{
    name: string;
    description: string;
    inputHint?: string;
  }>;
  buildLabel: string;
  agentLabel: string;
  defaultAgentSelection?: DownstreamAgentSelection;
}

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
  private state: UiState;
  private stream?: SessionStreamHandle;
  private autocompleteSignature = "";
  private stopped = false;
  private exitResolver?: () => void;
  private readonly exited: Promise<void>;

  constructor(private readonly params: NanobossTuiAppParams) {
    this.cwd = params.cwd ?? process.cwd();
    this.state = createInitialUiState({
      cwd: this.cwd,
      buildLabel: getBuildLabel(),
      agentLabel: "connecting",
      showToolCalls: params.showToolCalls,
    });
    this.view = new NanobossAppView(this.editor, this.theme, this.state);
    this.exited = new Promise<void>((resolve) => {
      this.exitResolver = resolve;
    });

    this.editor.onSubmit = (text) => {
      void this.handleSubmit(text);
    };

    this.tui.addInputListener((data) => {
      if (!matchesKey(data, "ctrl+c")) {
        return undefined;
      }

      this.editor.setText("");
      this.requestExit();
      return { consume: true };
    });

    this.tui.addChild(this.view);
    this.tui.setFocus(this.editor);
  }

  async run(): Promise<string | undefined> {
    this.tui.start();
    this.terminal.setTitle("nanoboss");
    this.tui.requestRender(true);

    try {
      const buildFreshnessNotice = getBuildFreshnessNotice(this.cwd);
      if (buildFreshnessNotice) {
        this.dispatch({ type: "local_status", text: buildFreshnessNotice });
      }

      this.editor.disableSubmit = true;
      await ensureMatchingHttpServer(this.params.serverUrl, {
        cwd: this.cwd,
        onStatus: (text) => {
          this.dispatch({ type: "local_status", text });
        },
      });

      const session = this.params.sessionId
        ? await resumeHttpSession(this.params.serverUrl, this.params.sessionId, this.cwd)
        : await createHttpSession(this.params.serverUrl, this.cwd);
      await this.applySession(session);
      if (this.params.sessionId) {
        this.dispatch({ type: "local_status", text: `[session] resumed ${session.sessionId}` });
      }
      this.editor.disableSubmit = this.state.inputDisabled;

      await this.exited;
      return this.state.sessionId || session.sessionId;
    } finally {
      await this.stop();
    }
  }

  private dispatch(action: Parameters<typeof reduceUiState>[1]): void {
    this.state = reduceUiState(this.state, action);
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

  private async applySession(session: SessionResponse): Promise<void> {
    if (this.stream) {
      this.stream.close();
      await this.stream.closed;
    }

    this.dispatch({
      type: "session_ready",
      sessionId: session.sessionId,
      buildLabel: session.buildLabel,
      agentLabel: session.agentLabel,
      commands: session.commands,
      defaultAgentSelection: session.defaultAgentSelection,
    });

    this.stream = startSessionEventStream({
      baseUrl: this.params.serverUrl,
      sessionId: session.sessionId,
      onEvent: (event) => {
        this.dispatch({ type: "frontend_event", event });
      },
      onError: (error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.dispatch({ type: "local_status", text: `[stream] ${message}` });
      },
    });
  }

  private async handleSubmit(text: string): Promise<void> {
    const trimmed = text.trim();
    if (trimmed.length === 0 || this.state.inputDisabled) {
      return;
    }

    if (isExitRequest(trimmed)) {
      this.editor.setText("");
      this.requestExit();
      return;
    }

    if (isNewSessionRequest(trimmed)) {
      this.editor.setText("");
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
    }

    this.editor.addToHistory(text);
    this.editor.setText("");
    await this.forwardPrompt(text);
  }

  private async createNewSession(): Promise<void> {
    this.editor.disableSubmit = true;
    this.dispatch({ type: "local_status", text: "[session] creating new session…" });

    try {
      const session = await createHttpSession(
        this.params.serverUrl,
        this.cwd,
        this.state.defaultAgentSelection,
      );
      await this.applySession(session);
      this.dispatch({ type: "local_status", text: `[session] new ${session.sessionId}` });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.dispatch({ type: "local_status", text: `[session] ${message}` });
    } finally {
      this.editor.disableSubmit = this.state.inputDisabled;
    }
  }

  private async openModelPicker(): Promise<void> {
    const selection = await promptForModelSelection(this.tui, this.theme, this.state.defaultAgentSelection);
    this.tui.setFocus(this.editor);
    this.tui.requestRender(true);

    if (!selection) {
      return;
    }

    this.applyLocalSelection(selection);
    const command = buildModelCommand(selection.provider, selection.model ?? "default");
    this.editor.addToHistory(command);
    this.editor.setText("");
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

  private async forwardPrompt(prompt: string): Promise<void> {
    this.dispatch({ type: "local_user_submitted", text: prompt });

    try {
      await sendSessionPrompt(this.params.serverUrl, this.state.sessionId, prompt);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.dispatch({ type: "local_send_failed", error: message });
    }
  }

  private requestExit(): void {
    if (this.stopped) {
      return;
    }

    this.exitResolver?.();
  }

  private async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }

    this.stopped = true;
    if (this.stream) {
      this.stream.close();
      await this.stream.closed;
      this.stream = undefined;
    }

    try {
      await this.terminal.drainInput(100, 20);
    } catch {
      // Ignore drain failures during shutdown.
    }

    this.tui.stop();
  }
}
