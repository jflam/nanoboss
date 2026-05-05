# `@nanoboss/adapters-tui`

`@nanoboss/adapters-tui` owns the interactive terminal UI adapter for Nanoboss.
It turns runtime events and stored session state into a pi-tui experience,
handles local TUI commands, hosts TUI extensions, and starts or connects to the
HTTP runtime service for CLI sessions.

It owns:

- the interactive TUI app and CLI runner
- TUI controller state transitions and frontend event reduction
- terminal views, transcript rendering, composer behavior, and overlays
- command parsing for local TUI commands
- theme creation and TUI formatting helpers
- adapter-private key binding, chrome, activity bar, panel, and form renderer
  registries
- TUI extension bootstrapping into concrete adapter registries
- built-in TUI extension contributions
- clipboard integration behind platform-specific providers

It does not own:

- durable cross-package state contracts
- procedure authoring helpers or procedure execution semantics
- HTTP server/client protocol ownership beyond adapter startup and connection
- TUI extension discovery, load ordering, or activation status catalogs
- the public extension authoring SDK
- store persistence implementation

Those boundaries matter:

- `@nanoboss/app-runtime` owns adapter-neutral runtime behavior and frontend
  event contracts.
- `@nanoboss/adapters-http` owns the HTTP/SSE service and client protocol.
- `@nanoboss/tui-extension-sdk` owns extension authoring types.
- `@nanoboss/tui-extension-catalog` owns extension discovery and activation
  bookkeeping.
- `@nanoboss/store` owns persisted session/run/value state.

## Public Interface

The package entrypoint is `packages/adapters-tui/src/index.ts`.

The entrypoint is intentionally explicit. It exposes the current adapter-facing
surface without wildcard barrels, grouped around:

- CLI/app runtime:
  - `runTuiCli`
  - `canUseNanobossTui`
  - `assertInteractiveTty`
  - `NanobossTuiApp`
  - `NanobossTuiController`
- state and reduction:
  - `createInitialUiState`
  - `reduceUiState`
  - TUI state/action types
- views and overlays:
  - `NanobossAppView`
  - `promptForStoredSessionSelection`
- extension boot helpers:
  - `bootExtensions`
  - `createTuiExtensionContextFactory`
  - extension boot result/options/log types
- theme:
  - `createNanobossTuiTheme`
  - theme-related types

## Internal Shape

The package is currently the largest Nanoboss package. The main size drivers
are:

- `app.ts`: terminal app wiring, editor behavior, and local command dispatch
- `app-binding-hooks.ts`: app-level keybinding hook wiring for cooldown and
  queued-prompt behavior
- `app-autocomplete.ts`: slash-aware app autocomplete provider and command
  list synchronization helper
- `commands.ts`: local slash-command list, parsing, and submit-state helpers
- `command-extensions-card.ts`: `/extensions` local command card formatting
- `app-clipboard.ts`: app-level clipboard image paste and image-token deletion
  helpers
- `app-composer.ts`: app-level composer snapshot and cursor helpers
- `composer-prompt-input.ts`: composer text and image-token prompt-input
  assembly helper
- `app-controller-deps.ts`: app-to-controller dependency adapter helper
- `app-continuation-composer.ts`: app-level inline continuation composer
  lifecycle helpers
- `app-continuation-form.ts`: app-level continuation form extraction and
  signature helpers
- `app-continuation-renderer.ts`: app-level continuation form renderer lookup,
  validation, and render-context helper
- `app-editor-handlers.ts`: app-level editor submit/change handler wiring
- `app-input-listener.ts`: app-level terminal input listener and keybinding
  dispatch wiring
- `app-inline-select.ts`: app-level inline select overlay mounting helper
- `app-live-updates.ts`: app-level live-update pause and refresh timer
  behavior
- `app-model-selection.ts`: app-level inline model picker and persistence
  confirmation flow
- `app-sigint-exit.ts`: app-level ctrl-c double-press exit helper
- `app-types.ts`: app-local dependency adapter contracts
- `reducer.ts`: frontend event reduction and state transition logic
- `reducer-actions.ts`: reducer action contracts shared by controller and
  reducer helper modules
- `reducer-session-ready.ts`: reducer-owned session-ready state reset and
  available-command merge helpers
- `state-initial.ts`: initial TUI state construction defaults
- `reducer-local-actions.ts`: reducer-owned local/controller action dispatch
- `reducer-local-turns.ts`: reducer-owned local submitted/send-failed turn
  construction
- `reducer-local-procedure-panels.ts`: reducer-owned local procedure-panel
  transcript state helpers
- `reducer-tool-calls.ts`: reducer-owned tool-call list and preview helpers
- `reducer-tool-event-records.ts`: reducer-owned tool start/update record
  construction helpers
- `reducer-tool-events.ts`: reducer-owned tool start/update event reducers
- `reducer-turn-factory.ts`: reducer-owned generic turn id, construction,
  and assistant meta helpers
- `reducer-turns.ts`: reducer-owned streamed assistant turn and active-turn
  block helpers
- `reducer-transcript-items.ts`: reducer-owned transcript item add/remove
  helpers
- `reducer-run-completion.ts`: reducer-owned terminal run cleanup helpers
- `reducer-run-completion-note.ts`: reducer-owned run completion-note
  duration and turn-number formatting helpers
- `reducer-run-finalize-turn.ts`: reducer-owned assistant-turn finalization
  helpers
- `reducer-run-restore.ts`: reducer-owned restored run replay transitions
- `reducer-run-events.ts`: reducer-owned live run lifecycle frontend event
  transitions
- `reducer-run-outcomes.ts`: reducer-owned terminal run outcome transitions
- `reducer-panel-cards.ts`: reducer-owned procedure-card and transcript card
  rendering helpers
- `reducer-procedure-panel-turns.ts`: reducer-owned procedure-panel
  active-turn block mutation helpers
- `reducer-procedure-panels.ts`: reducer-owned frontend procedure-panel
  transcript state and turn-block helpers
- `reducer-panels.ts`: reducer-owned non-transcript ui_panel helpers
- `controller.ts`: session/runtime orchestration for the TUI
- `controller-auto-approve.ts`: controller-owned session auto-approve toggle
  helper
- `controller-input-flow.ts`: controller-owned busy-input, pending-prompt,
  and terminal-event helpers
- `controller-local-cards.ts`: controller-owned local card action and
  `/extensions` card formatting helpers
- `controller-model-inline-validation.ts`: controller-owned inline model
  catalog refresh and validation helpers
- `controller-model-selection.ts`: controller-owned model selection
  application, picker, and default persistence helpers
- `controller-model-persistence.ts`: controller-owned model selection
  persistence and local selection action helpers
- `controller-prompt-flow.ts`: controller-owned prompt forwarding and
  pending-prompt flushing helpers
- `controller-run.ts`: controller-owned initial run/connect/resume lifecycle
  helper
- `controller-session.ts`: controller-owned HTTP session connect/create and
  `/new` session lifecycle helpers
- `controller-stop.ts`: controller-owned run stop and continuation cancel
  helpers
- `controller-stream.ts`: controller-owned session event stream lifecycle
  helpers
- `controller-submit-local-commands.ts`: controller-owned local submit command
  branch handlers
- `controller-submit.ts`: controller-owned prompt submit and queued-prompt
  command flow helpers
- `controller-types.ts`: controller public and app-facing dependency contracts
- `activity-bar-cascade.ts`: activity-bar priority-drop rendering cascade
  helper
- `activity-bar.ts`: activity-bar segment registry and line rendering entry
- `boot-extension-activation.ts`: extension activation, contribution count
  publication, and aggregate failure summary helper
- `boot-extension-contributions.ts`: extension contribution registration,
  namespacing, shadowing, and count helpers
- `boot-extension-context.ts`: extension context factory and activation logger
  wiring
- `boot-extension-registry.ts`: extension registry construction, builtin
  seeding, and disk loading helper
- `build-freshness-rules.ts`: TUI build-freshness evaluation and git-status
  path filtering rules
- `build-freshness.ts`: TUI build-freshness filesystem and git probing helper
- `run-extensions.ts`: CLI TUI extension boot status buffering and replay
- `run-signals.ts`: CLI TUI process signal handling helpers
- `run-terminal.ts`: CLI terminal control-character and process signal helpers
- `core-bindings.ts`: core keybinding registration manifest
- `core-bindings-actions.ts`: core keybinding app/controller action
  dispatch helpers
- `core-bindings-help.ts`: core keybinding help-card markdown formatter
- `core-chrome.ts`: core chrome contribution registration manifest
- `core-chrome-activity.ts`: core activity-bar chrome component and
  overflow handling
- `core-chrome-components.ts`: core chrome component factories and
  truncation wrappers
- `core-chrome-lines.ts`: core chrome header, session, status, and footer line
  formatting helpers
- `core-activity-identity.ts`: core identity activity-bar segment helpers
- `views.ts`: transcript, chrome, and panel composition
- `views-panels.ts`: non-transcript ui_panel chrome host components
- `views-procedure-panels.ts`: transcript procedure-panel rendering and
  replay fallback helpers
- `views-turns.ts`: transcript turn rendering components
- `views-transcript.ts`: transcript item composition and tool entry rendering
  components
- `components/tool-card-expanded.ts`: expanded tool-card payload
  normalization helpers
- `components/tool-card-diff.ts`: tool-card diff detection and line styling
  helpers
- `components/tool-card-code-preview.ts`: tool-card code preview rendering,
  diff fallback, and syntax highlighting helper
- `components/tool-card-code-context.ts`: tool-card code language and
  highlighting context inference
- `components/tool-card-header.ts`: tool-card header, canonical name, and
  duration formatting helpers
- `components/tool-card-body.ts`: tool-card preview, warning, and error body
  formatting helpers
- `components/tool-card-format.ts`: shared tool-card rendering assembly helpers
- `theme-ansi.ts`: reusable ANSI foreground/background/attribute styling
  primitives
- `theme-languages.ts`: file-extension language inference for syntax
  highlighting
- `theme-highlight.ts`: tool-card code highlighting adapter for
  `cli-highlight`
- `theme-tool-card.ts`: tool-card palette data and RGB styling helpers
- `theme.ts`: adapter theme construction

Keep changes in those files focused. When behavior naturally has its own
ownership boundary, prefer adding or extending a smaller sibling module instead
of growing `reducer.ts`, `app.ts`, or `controller.ts` further.

## Simplification Rules

- Keep the package entrypoint explicit; do not reintroduce wildcard barrels.
- Keep extension authoring types in `@nanoboss/tui-extension-sdk`.
- Keep extension catalog/discovery behavior in `@nanoboss/tui-extension-catalog`.
- Keep adapter-private implementation helpers out of the public entrypoint
  unless root commands, package consumers, or intentional tests need them.
- Keep registry/context wiring in the extension boot helpers; do not let
  extension activation bypass namespacing or catalog precedence rules.
- Keep protocol-level HTTP behavior in `@nanoboss/adapters-http`.

## Current Review Metrics

Measured during the 2026-05 TUI adapter review:

- source files: 129
- source lines: 9,765
- largest file: `src/controller.ts` at 355 lines
- workspace package dependencies: 9
- runtime value exports: 46 -> 12
- public wildcard exports: 8 -> 0
- code simplification applied:
  - replaced the public wildcard barrel with an explicit named-entrypoint
    barrel while preserving the existing public surface
  - internalized transcript/select-overlay/core-card renderer helpers from the
    package entrypoint while keeping direct source-level tests for those seams
  - internalized local command parser/formatter helpers behind controller/app
    behavior
  - internalized form renderer registry helpers behind TUI app behavior
  - removed test-only form renderer list/reset helpers by using isolated
    registry ids in tests
  - internalized key binding, chrome, activity-bar, and panel registry helpers
    behind adapter source modules and extension boot context wiring
  - split reducer-owned tool-call list and preview helpers out of the central
    reducer
  - split reducer-owned tool start/update event reducers out of the central
    reducer
  - split reducer-owned tool start/update record construction out of tool
    event state transitions
  - split reducer action contracts out of the central reducer
  - split initial TUI state construction defaults out of state contracts
  - split session-ready state reset and available-command merge helpers out
    of local action dispatch
  - split reducer-owned local/controller action handling out of the central
    reducer
  - split reducer-owned assistant turn and transcript helpers out of the
    central reducer
  - split reducer-owned transcript item add/remove helpers out of streamed
    assistant turn mutation
  - split reducer-owned generic turn construction and assistant meta helpers
    out of streamed assistant text handling
  - split terminal run completion, completion-note, and panel-eviction helpers
    out of the central reducer
  - split procedure-card, procedure-panel, and ui-panel helpers out of the
    central reducer
  - split reducer-owned procedure-card and transcript card rendering helpers
    out of the panel reducer
  - split reducer-owned procedure-panel active-turn block mutation helpers
    out of procedure-panel state transitions
  - split file-extension language inference out of the TUI theme constructor
  - split reusable ANSI styling primitives out of the TUI theme constructor
  - split tool-card palette data and RGB styling helpers out of the TUI
    theme constructor
  - split tool-card code highlighting adapter wiring out of the TUI theme
    constructor
  - split app-level composer snapshot, prompt-input, and cursor helpers out of
    the TUI app
  - split composer text and image-token prompt-input assembly out of composer
    image state
  - split app-level keybinding hook wiring for cooldown and queued-prompt
    behavior out of the TUI app
  - split app-level clipboard image paste and image-token deletion helpers out
    of the TUI app
  - split app-level live-update pause and refresh timer behavior out of the
    TUI app
  - split app-local dependency adapter contracts out of the TUI app
  - split transcript turn, tool, and procedure-panel rendering out of the
    TUI view shell
  - split transcript procedure-panel rendering and replay fallback helpers out
    of the transcript component
  - split non-transcript ui_panel chrome hosts out of the TUI view shell
  - split app-level continuation form extraction and signature helpers out of
    the TUI app
  - split app-level inline continuation composer lifecycle helpers out of the
    TUI app
  - split app-level continuation form renderer lookup and validation out of
    inline continuation composer lifecycle
  - split app-level editor submit/change handler wiring out of the TUI app
  - split app-level terminal input listener and keybinding dispatch wiring out
    of the TUI app
  - split app-level ctrl-c double-press exit handling out of the TUI app
  - split app-level inline select overlay mounting out of the TUI app
  - split controller-owned busy-input, pending-prompt, and terminal-event
    helpers out of the TUI controller
  - consolidated controller busy-input steering and queued prompt handling
    into the controller input-flow helper
  - split controller-owned local card action and `/extensions` card formatting
    helpers out of the TUI controller
  - split controller-owned model validation, picker, and default persistence
    helpers out of the TUI controller
  - split controller-owned session auto-approve toggle helper out of the TUI
    controller
  - split controller-owned prompt forwarding and pending-prompt flushing
    helpers out of the TUI controller
  - split controller-owned initial run/connect/resume lifecycle helper out of
    the TUI controller
  - split controller-owned HTTP session connect/create and `/new` session
    lifecycle helpers out of the TUI controller
  - split controller-owned run stop and continuation cancel helpers out of
    the TUI controller
  - split controller-owned session event stream lifecycle helpers out of the
    TUI controller
  - split controller-owned prompt submit and queued-prompt command flow
    helpers out of the TUI controller
  - split controller-owned local submit command branch handlers out of prompt
    submit flow
  - split controller public and app-facing dependency contracts out of the
    TUI controller
  - split TUI build-freshness evaluation and git-status path filtering rules
    out of filesystem/git probing
  - split the slash-aware app autocomplete provider and command-list
    synchronization helper out of the TUI app
  - split app-level inline model picker and persistence confirmation flow out
    of the TUI app
  - split expanded tool-card payload normalization helpers out of shared
    tool-card formatting
  - split tool-card diff detection and line styling helpers out of shared
    tool-card formatting
  - split extension context factory and contribution namespacing helpers out
    of extension boot orchestration
  - split extension contribution registration, shadowing, and count handling
    out of context factory construction
  - split extension registry preparation and activation summary handling out
    of the extension boot entrypoint
  - split reducer-owned run lifecycle frontend event transitions out of the
    central reducer
  - split reducer-owned terminal run outcome transitions out of live run
    lifecycle updates
  - split CLI terminal control-character and signal helpers out of the TUI
    runner
  - split CLI TUI extension boot status buffering and process signal handling
    out of the TUI runner
  - split reducer-owned procedure-panel transcript state and turn-block
    helpers out of generic ui_panel handling
  - split core chrome component factories and line formatting helpers out of
    the registration manifest
  - split core chrome line formatting helpers out of component factory
    wrappers
  - split core activity-bar chrome rendering and overflow handling out of
    generic chrome line helpers
  - split assistant-turn finalization and completion-note helpers out of
    reducer run cleanup
  - split run completion-note duration and turn-number formatting out of
    assistant-turn finalization
  - split core keybinding help-card formatting out of the registration
    manifest
  - split core keybinding app/controller action dispatch helpers out of the
    registration manifest
  - split app-to-controller dependency adapter wiring out of the TUI app
    constructor
  - split tool-card code language and highlighting context inference out of
    shared tool-card formatting
  - split tool-card code preview rendering and syntax highlighting out of
    shared tool-card formatting
  - split transcript turn rendering components out of the transcript item
    composition shell
  - split tool-card header, canonical name, and duration formatting out of
    shared tool-card formatting
  - split tool-card preview, warning, and error body formatting out of shared
    tool-card rendering assembly
  - split restored run replay transitions out of live run lifecycle reducers
  - split local submitted/send-failed turn construction out of local action
    dispatch
  - split local procedure-panel transcript state helpers out of frontend
    procedure-panel event handling
  - split model selection persistence and local selection action helpers out
    of controller model validation/picker flow
  - split inline model catalog refresh and validation helpers out of
    controller model picker flow
  - split core identity activity-bar segments out of the run-state
    registration manifest
  - split activity-bar priority-drop cascade rendering out of the segment
    registry
  - split `/extensions` local command card formatting out of generic command
    parsing

The useful outcome of this pass is the entrypoint baseline: future TUI adapter
exports should be deliberate additions, not accidental leakage from broad
module re-exports.

## Good Future Targets

- Split reducer subdomains once a behavior slice has stable tests around it.
- Revisit whether package tests that exercise adapter internals can import
  internal modules directly, allowing the public entrypoint to shrink.
- Continue moving reusable extension-facing contracts toward
  `@nanoboss/tui-extension-sdk` and host/catalog behavior toward the catalog
  package when those boundaries become clear.
