# `@nanoboss/tui-extension-sdk`

`@nanoboss/tui-extension-sdk` is the public authoring contract for Nanoboss
TUI extensions. It is a types-only package: extension modules import its
interfaces to describe panel renderers, chrome contributions, activity bar
segments, key bindings, metadata, and activation hooks, but the package exports
no runtime values.

It owns:

- structural component and theme contracts consumed by extension renderers
- read-only TUI state snapshots exposed to extension code
- panel renderer, chrome contribution, and activity bar segment contracts
- key binding contracts and the host hooks available while dispatching them
- extension metadata, scope, logger, activation context, and module shape
- compatibility aliases that keep existing extension source compiling

It does not own:

- concrete TUI app state
- pi-tui component classes
- contribution registries
- disk discovery, loading, or activation precedence
- built-in extension implementations
- runtime registration functions
- protocol-specific adapter behavior

Those boundaries matter:

- `@nanoboss/adapters-tui` owns the concrete TUI state, views, registries, and
  runtime registration helpers.
- `@nanoboss/tui-extension-catalog` owns discovery, validation, load order, and
  activation status.
- extension authors should register all contributions through
  `TuiExtensionContext`; they should not import host-private `register*`
  functions from the TUI adapter.

## Public Interface

The package entrypoint is `packages/tui-extension-sdk/src/index.ts`.

The runtime value surface is intentionally empty. The smoke test imports the
package namespace and asserts that it resolves while exposing zero runtime
bindings.

The public type surface is organized around these families:

- component/theme contracts:
  - `Component`
  - `NanobossTuiTheme`
  - `ToolCardThemeMode`
- state snapshots:
  - `TuiExtensionState`
  - `TuiExtensionAgentSelection`
  - `TuiExtensionTurnSnapshot`
  - `TuiExtensionToolCallSnapshot`
  - `TuiExtensionPendingPromptSnapshot`
  - `UiState`
- panels:
  - `PanelRenderContext`
  - `PanelRenderer`
- chrome:
  - `ChromeSlotId`
  - `ChromeRenderContext`
  - `ChromeContribution`
- activity bar:
  - `ActivityBarLine`
  - `ActivityBarSegmentContext`
  - `ActivityBarSegment`
- key bindings:
  - `KeyMatcher`
  - `KeyBindingCategory`
  - `BindingResult`
  - `KeyBindingController`
  - `KeyBindingEditor`
  - `KeyBindingAppHooks`
  - `BindingCtx`
  - `KeyBinding`
- extension lifecycle:
  - `TuiExtensionScope`
  - `TuiExtensionMetadata`
  - `TuiExtensionLogger`
  - `TuiExtensionContext`
  - `TuiExtension`

## Compatibility Notes

`UiState` is a compatibility alias for `TuiExtensionState`. New SDK-facing code
should prefer `TuiExtensionState`, but the alias should remain until there is an
explicit extension migration plan.

`KeyBindingAppHooks` exposes app-private hooks structurally. Keep this type in
the SDK only for hooks that extension key bindings genuinely need during
dispatch; concrete implementations still belong to the TUI adapter.

## Simplification Rules

- Keep the package types-only.
- Do not add runtime registration functions here.
- Prefer structural contracts over concrete TUI implementation classes.
- Add new state fields only when extension renderers or gates need a stable
  read-only view of that data.
- Keep catalog concerns in `@nanoboss/tui-extension-catalog`.
- Keep adapter concerns in `@nanoboss/adapters-tui`.

## Current Review Metrics

Measured during the 2026-05 TUI extension SDK review:

- source files: 1
- `src/index.ts` lines: 384
- workspace package dependencies: 1 (`@nanoboss/procedure-sdk`, type-only)
- runtime value exports: 0
- public wildcard exports: 0
- public type symbols: 30
- code simplification applied: none; the package is already a minimal
  types-only authoring contract

The useful outcome of this pass is the boundary baseline: future changes should
be suspicious if they add runtime behavior, host registries, or concrete TUI
implementation types to this package.

## Good Future Targets

- Split the source file into internal topic files if editing the 384-line
  entrypoint becomes cumbersome, while keeping the public entrypoint explicit.
- Revisit the `UiState` compatibility alias only after extension source has an
  announced migration path.
- Add consumer-style fixture tests if third-party extension examples start to
  depend on additional SDK contracts.
