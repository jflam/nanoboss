# `@nanoboss/tui-extension-catalog`

`@nanoboss/tui-extension-catalog` is the TUI extension discovery and activation
catalog. It finds extension modules, applies builtin/profile/repo precedence,
tracks activation status, and activates extensions through SDK-owned contracts.

It owns:

- extension registry state
- disk extension discovery and lazy loading
- builtin/profile/repo precedence
- activation status and activation failure isolation
- contribution counts reported back to TUI status displays

It does not own:

- extension authoring contracts
- concrete TUI renderers or registries
- builtin renderer implementations
- TUI layout, reducer, controller, or view behavior
- generic disk-module loading mechanics

Those boundaries matter:

- `@nanoboss/tui-extension-sdk` owns extension authoring contracts.
- `@nanoboss/adapters-tui` owns concrete TUI registries, renderers, and boot
  wiring.
- `@nanoboss/app-support` owns generic disk module discovery/loading mechanics
  and extension root paths.

## Public Interface

The public entrypoint is `packages/tui-extension-catalog/src/index.ts`.

### Registry

- `TuiExtensionRegistry`
- `TuiExtensionRegistryOptions`

This is the main runtime API. Adapters create a registry, seed builtin
extensions, load disk extensions, activate everything through a context factory,
and read metadata/status for `/extensions`.

### Activation context

- `TuiExtensionContextFactory`

The catalog calls this factory during activation. The concrete factory lives in
`@nanoboss/adapters-tui` because it mutates adapter-owned keybinding, chrome,
activity-bar, and panel-renderer registries.

### Status and counts

- `TuiExtensionStatus`
- `TuiExtensionContributionCounts`

Adapters use these status shapes for extension-list rendering and boot
diagnostics. Lower-level activation status internals stay private to the
catalog.

## Private Internals

The package still has internal source exports for local module composition, but
they are intentionally not exposed from the package entrypoint:

- `assertTuiExtension(...)`
- `discoverDiskTuiExtensions(...)`
- `loadTuiExtensionFromPath(...)`
- `LoadableTuiExtensionRegistry`
- `RegisteredTuiExtension`
- disk discovery result shapes

Those names are implementation details of registry loading. External callers
should use `TuiExtensionRegistry` instead of reconstructing partial registry
behavior from lower-level pieces.

## Package Structure

- `src/registry.ts`
  Registry state, precedence, disk loading orchestration, activation, and
  status projection.
- `src/loadable-registry.ts`
  Internal loadable registry entry shapes and extension validation.
- `src/disk-loader.ts`
  Extension-specific discovery metadata and module validation.
- `src/paths.ts`
  Extension root helpers from app-support.

## Boot Flow

1. `@nanoboss/adapters-tui` creates `TuiExtensionRegistry`.
2. The adapter registers builtin extensions that need concrete TUI renderers.
3. The registry loads profile/repo extensions from disk.
4. The adapter creates a `TuiExtensionContextFactory` that namespaces
   contribution ids and mutates adapter-owned registries.
5. The catalog activates each selected extension and records status/counts.
6. The adapter renders status through `/extensions` and boot diagnostics.

The catalog never imports `@nanoboss/adapters-tui`. That acyclic direction is
enforced by the package dependency-direction tests.

## Simplification Rules

- Keep the package entrypoint focused on registry/status workflows.
- Do not export disk loader pieces unless a real caller needs raw disk
  discovery without activation semantics.
- Keep concrete TUI registration in `@nanoboss/adapters-tui`.
- Keep authoring contracts in `@nanoboss/tui-extension-sdk`.
- If activation policy grows, split private files before widening the public
  surface.

## Current Review Metrics

Measured during the 2026-05 TUI extension catalog review:

- source files: 5
- source lines: 432
- largest file: `src/registry.ts` at 249 lines
- public catalog symbols: reduced from 13 to 5
- package dependency direction: catalog depends on `app-support` and
  `tui-extension-sdk`, not `adapters-tui`

The cleanup is a public-surface reduction. Runtime behavior still goes through
`TuiExtensionRegistry`; raw disk loading and assertion helpers are no longer
advertised as package-level capabilities.

## Good Future Targets

- If status rendering needs more fields, add them to `TuiExtensionStatus`
  intentionally rather than exporting internal registry entries.
- Keep disk-loader tests in this package but prefer registry-level assertions
  for public behavior.
- Revisit whether `TuiExtensionRegistryOptions` needs to remain public after
  adapter boot wiring settles.
