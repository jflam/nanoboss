import type { PromptInput } from "@nanoboss/procedure-sdk";
import type { ClipboardImageProvider } from "./clipboard/provider.ts";
import type { NanobossTuiControllerDeps } from "./controller.ts";
import type { TuiExtensionStatus } from "@nanoboss/tui-extension-catalog";
import type { UiState } from "./state.ts";
import type { NanobossTuiTheme } from "./theme.ts";
import type { InlineModelSelectionDeps } from "./app-model-selection.ts";

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

export interface EditorLike {
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

export interface TerminalLike {
  setTitle(title: string): void;
  drainInput(timeoutMs: number, rounds: number): Promise<void>;
}

export interface TuiLike {
  addInputListener(listener: (data: string) => unknown): void;
  addChild(child: unknown): void;
  setFocus(component: unknown): void;
  start(): void;
  requestRender(force?: boolean): void;
  stop(): void;
}

export interface ViewLike {
  setState(state: UiState): void;
  showComposer(component: unknown): void;
  showEditor(): void;
}

export interface ControllerLike {
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

export interface NanobossTuiAppDeps {
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
