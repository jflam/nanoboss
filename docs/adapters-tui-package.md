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
- key binding, chrome, activity bar, panel, and form renderer registries
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
- commands and formatting:
  - command predicates/parsers
  - `formatExtensionsCard`
- extension host registries:
  - key bindings
  - chrome contributions
  - activity bar segments
  - panel renderers
  - form renderers
  - extension boot helpers
- theme:
  - `createNanobossTuiTheme`
  - theme-related types

## Internal Shape

The package is currently the largest Nanoboss package. The main size drivers
are:

- `reducer.ts`: frontend event reduction and state transition logic
- `app.ts`: terminal app wiring, editor behavior, and local command dispatch
- `controller.ts`: session/runtime orchestration for the TUI
- `views.ts`: transcript, chrome, and panel composition
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

- source files: 47
- source lines: 7,963
- largest file: `src/reducer.ts` at 1,418 lines
- workspace package dependencies: 9
- runtime value exports: 46 -> 39
- public wildcard exports: 8 -> 0
- code simplification applied:
  - replaced the public wildcard barrel with an explicit named-entrypoint
    barrel while preserving the existing public surface
  - internalized transcript/select-overlay/core-card renderer helpers from the
    package entrypoint while keeping direct source-level tests for those seams

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
