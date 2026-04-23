/**
 * @nanoboss/tui-extension-sdk
 *
 * Types-only public contract between TUI extensions and the Nanoboss TUI.
 *
 * Extensions depend on this package for authoring types; they never import
 * the module-level `register*` functions directly. All runtime registration
 * happens through the `TuiExtensionContext` passed to `activate(ctx)`.
 */

import type { PromptInput, TypeDescriptor } from "@nanoboss/procedure-sdk";

/**
 * SDK-owned structural render result. It intentionally mirrors only the
 * component protocol the TUI host consumes, not the concrete pi-tui classes.
 */
export interface Component {
  render(width: number): string[];
  invalidate(): void;
}

export type ToolCardThemeMode = "dark" | "light";

export interface NanobossTuiTheme<
  EditorTheme = unknown,
  SelectListTheme = unknown,
  MarkdownTheme = unknown,
> {
  text: (text: string) => string;
  accent: (text: string) => string;
  muted: (text: string) => string;
  dim: (text: string) => string;
  success: (text: string) => string;
  error: (text: string) => string;
  warning: (text: string) => string;
  bold: (text: string) => string;
  italic: (text: string) => string;
  underline: (text: string) => string;
  toolCardPendingBg: (text: string) => string;
  toolCardSuccessBg: (text: string) => string;
  toolCardErrorBg: (text: string) => string;
  toolCardBorder: (text: string) => string;
  toolCardTitle: (text: string) => string;
  toolCardMeta: (text: string) => string;
  toolCardBody: (text: string) => string;
  toolCardAccent: (text: string) => string;
  toolCardWarning: (text: string) => string;
  toolCardSuccess: (text: string) => string;
  toolCardError: (text: string) => string;
  highlightCode: (code: string, lang?: string) => string[];
  getToolCardMode: () => ToolCardThemeMode;
  setToolCardMode: (mode: ToolCardThemeMode) => void;
  editor: EditorTheme;
  selectList: SelectListTheme;
  markdown: MarkdownTheme;
}

export interface TuiExtensionAgentSelection {
  provider: string;
  model?: string;
}

export interface TuiExtensionTurnSnapshot {
  id: string;
  role: "user" | "assistant" | "system";
  markdown: string;
  status?: "streaming" | "complete" | "failed" | "cancelled";
}

export interface TuiExtensionToolCallSnapshot {
  id: string;
  runId: string;
  title: string;
  kind: string;
  toolName?: string;
  status: string;
  durationMs?: number;
}

export interface TuiExtensionPendingPromptSnapshot {
  id: string;
  text: string;
  kind: "steering" | "queued";
}

/**
 * Read-only TUI state snapshot exposed to extension renderers and gates.
 * The concrete adapter state can contain more fields; extensions should only
 * rely on this SDK-owned subset.
 */
export interface TuiExtensionState {
  readonly cwd: string;
  readonly sessionId: string;
  readonly buildLabel: string;
  readonly agentLabel: string;
  readonly defaultAgentSelection?: TuiExtensionAgentSelection;
  readonly availableCommands: readonly string[];
  readonly turns: readonly TuiExtensionTurnSnapshot[];
  readonly toolCalls: readonly TuiExtensionToolCallSnapshot[];
  readonly pendingPrompts: readonly TuiExtensionPendingPromptSnapshot[];
  readonly activeRunId?: string;
  readonly activeProcedure?: string;
  readonly runStartedAtMs?: number;
  readonly pendingStopRequest: boolean;
  readonly stopRequestedRunId?: string;
  readonly statusLine?: string;
  readonly tokenUsageLine?: string;
  readonly inputDisabled: boolean;
  readonly inputDisabledReason?: "run" | "local";
  readonly showToolCalls: boolean;
  readonly expandedToolOutput: boolean;
  readonly toolCardThemeMode: ToolCardThemeMode;
  readonly simplify2AutoApprove: boolean;
  readonly liveUpdatesPaused?: boolean;
  readonly toolCardsHidden?: boolean;
}

/**
 * Compatibility alias for existing extension code. Prefer
 * TuiExtensionState in new SDK-facing contracts.
 */
export type UiState = TuiExtensionState;

/**
 * Per-renderer context handed to PanelRenderer.render. The payload has
 * already been validated against the renderer's schema by the host before
 * the view layer calls into this function.
 */
export interface PanelRenderContext<
  T,
  State extends TuiExtensionState = TuiExtensionState,
  Theme extends NanobossTuiTheme = NanobossTuiTheme,
> {
  payload: T;
  state: State;
  theme: Theme;
}

/**
 * A registered panel renderer. Renderer ids are the public contract
 * procedures target via ui.panel({ rendererId, ... }).
 */
export interface PanelRenderer<
  T = unknown,
  State extends TuiExtensionState = TuiExtensionState,
  Theme extends NanobossTuiTheme = NanobossTuiTheme,
> {
  rendererId: string;
  schema: TypeDescriptor<T>;
  render(ctx: PanelRenderContext<T, State, Theme>): Component;
}

/**
 * Named slots that compose the nanoboss TUI chrome. Slot order is declared
 * by the renderer; contributions choose their slot and relative order.
 */
export type ChromeSlotId =
  | "header"
  | "session"
  | "status"
  | "transcriptAbove"
  | "transcript"
  | "transcriptBelow"
  | "composerAbove"
  | "composer"
  | "composerBelow"
  | "activityBar"
  | "overlay"
  | "footer";

export interface ChromeRenderContext<
  State extends TuiExtensionState = TuiExtensionState,
  Theme extends NanobossTuiTheme = NanobossTuiTheme,
> {
  state: State;
  theme: Theme;
  getState: () => State;
  getNowMs: () => number;
}

export interface ChromeContribution<
  State extends TuiExtensionState = TuiExtensionState,
  Theme extends NanobossTuiTheme = NanobossTuiTheme,
> {
  /** Stable identifier; registrations are deduplicated by id. */
  id: string;
  slot: ChromeSlotId;
  /** Insertion-order tiebreak within a slot; lower comes first. */
  order?: number;
  /**
   * Optional state-level gate evaluated once at rebuild time. If it
   * returns false, the contribution is skipped.
   */
  shouldRender?(state: State): boolean;
  render(ctx: ChromeRenderContext<State, Theme>): Component;
}

export type ActivityBarLine = "identity" | "runState";

export interface ActivityBarSegmentContext<
  State extends TuiExtensionState = TuiExtensionState,
  Theme extends NanobossTuiTheme = NanobossTuiTheme,
> {
  state: State;
  theme: Theme;
  nowMs: number;
  /**
   * Degradation detail level for this render. 0 is the most detailed
   * representation; the line builder increments this for segments that
   * opt into sub-segment degradation via `detailLevels`.
   */
  detail: number;
}

export interface ActivityBarSegment<
  State extends TuiExtensionState = TuiExtensionState,
  Theme extends NanobossTuiTheme = NanobossTuiTheme,
> {
  /** Stable identifier; registrations are deduplicated by id. */
  id: string;
  line: ActivityBarLine;
  /** Left-to-right placement within the line; lower comes first. */
  order?: number;
  /**
   * Lower priority is degraded/dropped first by the cascade. Defaults
   * to 0.
   */
  priority?: number;
  /**
   * Number of additional detail steps (beyond detail=0) this segment
   * supports before being fully dropped.
   */
  detailLevels?: number;
  /**
   * If false, the segment is never removed by the cascade once its detail
   * reaches `detailLevels`; the cascade moves on to the next segment.
   */
  droppable?: boolean;
  shouldRender?(state: State): boolean;
  render(ctx: ActivityBarSegmentContext<State, Theme>): string | undefined;
}

export type KeyMatcher = string | ((data: string) => boolean);

export type KeyBindingCategory =
  | "compose"
  | "run"
  | "tools"
  | "theme"
  | "commands"
  | "overlay"
  | "custom";

export interface BindingResult {
  consume?: boolean;
}

export interface KeyBindingController {
  toggleToolOutput(): void;
  toggleToolCardsHidden(): void;
  toggleSimplify2AutoApprove(): void;
  showLocalCard(opts: {
    key?: string;
    title: string;
    markdown: string;
    severity?: "info" | "warn" | "error";
    dismissible?: boolean;
  }): void;
  cancelActiveRun(): Promise<void> | void;
  queuePrompt(input: string | PromptInput): Promise<void> | void;
}

export interface KeyBindingEditor {
  getText(): string;
  isShowingAutocomplete(): boolean;
}

/**
 * App-private hooks exposed to registered bindings. They remain structural so
 * extensions can register bindings without importing the concrete TUI app.
 */
export interface KeyBindingAppHooks {
  handleCtrlC(): boolean;
  handleCtrlVImagePaste(): Promise<void>;
  handleCtrlOWithCooldown(): void;
  toggleLiveUpdatesPaused(): void;
  handleTabQueue(): boolean;
}

export interface BindingCtx<State extends TuiExtensionState = TuiExtensionState> {
  controller: KeyBindingController;
  state: State;
  editor: KeyBindingEditor;
  app: KeyBindingAppHooks;
}

export interface KeyBinding<State extends TuiExtensionState = TuiExtensionState> {
  /** Stable identifier; registrations are deduplicated by id. */
  id: string;
  /**
   * Key identifier or a matcher function. If omitted, this binding is
   * docs-only: it appears in the overlay but never dispatches.
   */
  match?: KeyMatcher;
  /** State-level gate. If it returns false the binding is skipped. */
  when?: (state: State) => boolean;
  category: KeyBindingCategory;
  /** Human-readable one-line description shown in the overlay. */
  label: string;
  /** Insertion-order tiebreak within a category; lower comes first. */
  order?: number;
  run?: (ctx: BindingCtx<State>) => void | Promise<void> | BindingResult | undefined;
}

/**
 * Which tier this extension was loaded from.
 * - "builtin": compiled into Nanoboss itself
 * - "profile": `~/.nanoboss/extensions/`
 * - "repo":    `<repo>/.nanoboss/extensions/`
 */
export type TuiExtensionScope = "builtin" | "profile" | "repo";

/**
 * Static metadata exported by a TuiExtension module. Catalog discovery reads
 * this statically (without executing `activate`) when possible, so keep the
 * declaration free of side-effectful imports.
 */
export interface TuiExtensionMetadata {
  name: string;
  version: string;
  description: string;
  /**
   * Optional capability declarations. Used by the catalog for ordering and
   * for introspection surfaces like `/extensions`. All ids should be the
   * extension-local ids (the catalog namespaces them with `<name>/<id>` at
   * registration time).
   */
  provides?: {
    bindings?: string[];
    chromeContributions?: string[];
    activityBarSegments?: string[];
    panelRenderers?: string[];
  };
}

/**
 * Logger routed through the TUI status-line pathway so extension messages
 * surface to the user without crashing the TUI.
 */
export interface TuiExtensionLogger {
  info(text: string): void;
  warning(text: string): void;
  error(text: string): void;
}

/**
 * Runtime activation context. This is the only surface an extension uses to
 * mutate TUI state. The SDK intentionally does NOT re-export module-level
 * register* functions from the concrete TUI host; all registration must go
 * through this context so the catalog can namespace ids per extension and
 * enforce precedence (repo > profile > builtin).
 */
export interface TuiExtensionContext {
  readonly extensionName: string;
  readonly scope: TuiExtensionScope;
  readonly theme: NanobossTuiTheme;

  registerKeyBinding(binding: KeyBinding): void;
  registerChromeContribution(contribution: ChromeContribution): void;
  registerActivityBarSegment(segment: ActivityBarSegment): void;
  registerPanelRenderer<T>(renderer: PanelRenderer<T>): void;

  readonly log: TuiExtensionLogger;
}

/**
 * Authoring contract for a TUI extension. A module placed under
 * `.nanoboss/extensions/` default-exports a value of this shape.
 */
export interface TuiExtension {
  metadata: TuiExtensionMetadata;
  activate(ctx: TuiExtensionContext): void | Promise<void>;
  deactivate?(ctx: TuiExtensionContext): void | Promise<void>;
}
