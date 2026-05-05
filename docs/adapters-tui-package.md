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
- `app-autocomplete.ts`: slash-aware app autocomplete provider
- `app-clipboard.ts`: app-level clipboard image paste and image-token deletion
  helpers
- `app-composer.ts`: app-level composer snapshot, prompt-input, and cursor
  helpers
- `app-continuation-composer.ts`: app-level inline continuation composer
  lifecycle helpers
- `app-continuation-form.ts`: app-level continuation form extraction and
  signature helpers
- `app-editor-handlers.ts`: app-level editor submit/change handler wiring
- `app-live-updates.ts`: app-level live-update pause and refresh timer
  behavior
- `app-model-selection.ts`: app-level inline model picker and persistence
  confirmation flow
- `app-types.ts`: app-local dependency adapter contracts
- `reducer.ts`: frontend event reduction and state transition logic
- `reducer-actions.ts`: reducer action contracts shared by controller and
  reducer helper modules
- `reducer-local-actions.ts`: reducer-owned local/controller action handling
- `reducer-tool-calls.ts`: reducer-owned tool-call list and preview helpers
- `reducer-tool-events.ts`: reducer-owned tool start/update event reducers
- `reducer-turns.ts`: reducer-owned assistant turn and transcript helpers
- `reducer-run-completion.ts`: reducer-owned terminal run and completion-note
  helpers
- `reducer-panels.ts`: reducer-owned procedure-card, procedure-panel, and
  ui-panel helpers
- `controller.ts`: session/runtime orchestration for the TUI
- `controller-auto-approve.ts`: controller-owned session auto-approve toggle
  helper
- `controller-input-flow.ts`: controller-owned busy-input, pending-prompt,
  and terminal-event helpers
- `controller-local-cards.ts`: controller-owned local card action and
  `/extensions` card formatting helpers
- `controller-model-selection.ts`: controller-owned inline model validation,
  picker, and default persistence helpers
- `controller-prompt-flow.ts`: controller-owned prompt forwarding and
  pending-prompt flushing helpers
- `controller-session.ts`: controller-owned HTTP session connect/create and
  `/new` session lifecycle helpers
- `controller-stop.ts`: controller-owned run stop and continuation cancel
  helpers
- `controller-stream.ts`: controller-owned session event stream lifecycle
  helpers
- `controller-types.ts`: controller public and app-facing dependency contracts
- `views.ts`: transcript, chrome, and panel composition
- `views-panels.ts`: non-transcript ui_panel chrome host components
- `views-transcript.ts`: transcript turn, tool, and procedure-panel rendering
  components
- `components/tool-card-expanded.ts`: expanded tool-card payload
  normalization helpers
- `components/tool-card-format.ts`: shared tool-card rendering and line
  formatting helpers
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
- Prefer registry/context wiring in `boot-extensions.ts`; do not let extension
  activation bypass namespacing or catalog precedence rules.
- Keep protocol-level HTTP behavior in `@nanoboss/adapters-http`.

## Current Review Metrics

Measured during the 2026-05 TUI adapter review:

- source files: 76
- source lines: 8,777
- largest file: `src/controller.ts` at 435 lines
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
  - split reducer action contracts out of the central reducer
  - split reducer-owned local/controller action handling out of the central
    reducer
  - split reducer-owned assistant turn and transcript helpers out of the
    central reducer
  - split terminal run completion, completion-note, and panel-eviction helpers
    out of the central reducer
  - split procedure-card, procedure-panel, and ui-panel helpers out of the
    central reducer
  - split app-level composer snapshot, prompt-input, and cursor helpers out of
    the TUI app
  - split app-level keybinding hook wiring for cooldown and queued-prompt
    behavior out of the TUI app
  - split app-level clipboard image paste and image-token deletion helpers out
    of the TUI app
  - split app-level live-update pause and refresh timer behavior out of the
    TUI app
  - split app-local dependency adapter contracts out of the TUI app
  - split transcript turn, tool, and procedure-panel rendering out of the
    TUI view shell
  - split non-transcript ui_panel chrome hosts out of the TUI view shell
  - split app-level continuation form extraction and signature helpers out of
    the TUI app
  - split app-level inline continuation composer lifecycle helpers out of the
    TUI app
  - split app-level editor submit/change handler wiring out of the TUI app
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
  - split controller-owned HTTP session connect/create and `/new` session
    lifecycle helpers out of the TUI controller
  - split controller-owned run stop and continuation cancel helpers out of
    the TUI controller
  - split controller-owned session event stream lifecycle helpers out of the
    TUI controller
  - split controller public and app-facing dependency contracts out of the
    TUI controller
  - split the slash-aware app autocomplete provider out of the TUI app
  - split app-level inline model picker and persistence confirmation flow out
    of the TUI app
  - split expanded tool-card payload normalization helpers out of shared
    tool-card formatting

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
