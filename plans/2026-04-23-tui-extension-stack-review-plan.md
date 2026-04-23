# TUI extension stack review plan

## Purpose

Review and simplify the TUI extension stack:

- `@nanoboss/adapters-tui`
- `@nanoboss/tui-extension-sdk`
- `@nanoboss/tui-extension-catalog`

This is the first package review target because it contains the clearest
package-architecture exception: the dependency-direction test excludes the TUI
extension packages because they are cyclic with `adapters-tui`.

The desired outcome is a cycle-free extension architecture where SDK and catalog
packages define or load extension contracts without depending on concrete TUI
runtime implementation details.

## Current state

### Dependency shape

Current declared edges:

- `adapters-tui -> tui-extension-catalog`
- `adapters-tui -> tui-extension-sdk`
- `tui-extension-catalog -> tui-extension-sdk`
- `tui-extension-catalog -> adapters-tui`
- `tui-extension-sdk -> adapters-tui`

Current code edges:

- `packages/tui-extension-sdk/src/index.ts` imports public types from
  `@nanoboss/adapters-tui`.
- `packages/adapters-tui/src/boot-extensions.ts` imports
  `TuiExtensionRegistry` and SDK context types.
- `packages/tui-extension-catalog/src/builtins.ts` dynamically imports
  `@nanoboss/adapters-tui` to build the builtin `nb/card@1` renderer.
- `packages/adapters-tui/src/app.ts`, `controller.ts`, `commands.ts`, and
  tests consume `TuiExtensionStatus`.

### Architecture-test exception

`tests/unit/package-dependency-direction.test.ts` treats
`tui-extension-catalog` and `tui-extension-sdk` as additional workspace
packages rather than full layering participants. The comment says they are
excluded because the TUI extension SDK is cyclic with `adapters-tui` by design.

This plan treats that exception as temporary review debt.

### Known simplification smells

- `tui-extension-sdk` is meant to be a types-only authoring package but imports
  from `adapters-tui`, so it is not actually leaf-level.
- `tui-extension-catalog` owns discovery/activation status, but builtin
  extension loading reaches back into concrete TUI renderer implementation.
- `adapters-tui` both owns core registries and boots extension registry state,
  which makes it hard to tell where extension precedence policy belongs.
- `adapters-tui/src/commands.ts` retains a legacy `/extensions` formatter export
  for backwards compatibility.
- `adapters-tui/src/app.ts` still has legacy continuation UI comments around
  migration from `continuation.ui` to `continuation.form`.

## Desired package boundaries

### `@nanoboss/tui-extension-sdk`

Should own:

- Stable extension authoring types.
- Structural registration interfaces used by extensions.
- Extension metadata and context contracts.

Should not own:

- Concrete `adapters-tui` imports.
- Module-level TUI registries.
- Builtin extension implementations.
- Runtime boot policy.

### `@nanoboss/tui-extension-catalog`

Should own:

- Extension discovery from builtin/profile/repo sources.
- Extension precedence ordering.
- Activation/deactivation status.
- Namespaced metadata and contribution counts.

Should not own:

- Concrete TUI renderer implementations.
- Dynamic imports back into `adapters-tui`.
- Module-level TUI registry mutation.

### `@nanoboss/adapters-tui`

Should own:

- Concrete TUI registries and renderer implementations.
- Translation from runtime events into TUI state.
- TUI boot orchestration that wires catalog activation into concrete registries.
- Builtin TUI extension implementations if those implementations use TUI
  internals.

Should not own:

- SDK authoring contract definitions.
- Disk discovery policy that can live in the catalog.
- Compatibility surfaces not used outside tests or current commands.

## Proposed review phases

### Phase 1: inventory public surfaces and actual consumers

Actions:

- List every export from:
  - `packages/adapters-tui/src/index.ts`
  - `packages/tui-extension-sdk/src/index.ts`
  - `packages/tui-extension-catalog/src/index.ts`
- For each export, search all repo consumers.
- Mark each export as:
  - external contract
  - internal package wiring
  - test-only
  - legacy/compatibility
  - accidental

Questions:

- Do extension authors need `UiState`, `NanobossTuiTheme`, `PanelRenderer`,
  `ChromeContribution`, `ActivityBarSegment`, and `KeyBinding` from
  `adapters-tui`, or can those structural types move to the SDK?
- Does any code outside `adapters-tui` need module-level `register*` functions?
- Is the legacy `/extensions` string formatter used by any current caller?

Acceptance:

- Produce a concrete export disposition table before editing package edges.

#### Phase 1 inventory results

Generated on 2026-04-23 by expanding the three public barrels with the
TypeScript checker and tracing repo consumers with symbol search. "Package
source" means the symbol is consumed by implementation files in the same package
or by the current cyclic package edge; "public import" names imports through a
package entrypoint.

Key answers before changing package edges:

- Extension-facing structural types should move to `@nanoboss/tui-extension-sdk`
  when they are pure contracts: `NanobossTuiTheme`, `PanelRenderer`,
  `PanelRenderContext`, `ChromeContribution`, `ChromeRenderContext`,
  `ChromeSlotId`, `ActivityBarSegment`, `ActivityBarSegmentContext`, and the
  extension-safe part of `KeyBinding`.
- `UiState` should not move as the full adapters runtime state. The SDK should
  own a narrower read-only extension state contract if extensions need state
  gates.
- `KeyBinding` can move only after replacing adapter-only dependencies in its
  nested types (`KeyMatcher` currently depends on pi-tui `KeyId`, and
  `BindingCtx` exposes concrete controller/editor/app hooks).
- No production code outside `adapters-tui` needs module-level `register*`
  functions. Current external authoring code uses `ctx.register*`; module-level
  functions are adapters runtime wiring plus tests.
- The legacy `/extensions` string formatter `formatExtensionsList` has no
  current production caller. The live caller is `formatExtensionsCard` via
  `NanobossTuiController.emitExtensionsList`; `formatExtensionsList` is
  test-covered compatibility only.

Adapters TUI public exports:

| Export | Consumer evidence | Class | Recommended disposition |
| --- | --- | --- | --- |
| `ActivityBarLine` | Package source only (`activity-bar`, `core-chrome`). | internal package wiring | Keep internal to adapters; public re-export is not extension-facing. |
| `ActivityBarSegment` | Package source, adapters tests, SDK re-export. | external contract | Move contract to SDK; adapters may temporarily re-export for compatibility. |
| `ActivityBarSegmentContext` | Package source only. | external contract | Move with `ActivityBarSegment` if the segment contract moves. |
| `assertInteractiveTty` | Public import from `cli.ts` and `resume.ts`; unit resume test. | external contract | Keep in adapters public CLI surface. |
| `BindingCtx` | Package source and adapters tests. | internal package wiring | Split before moving `KeyBinding`; avoid exporting concrete app hooks from SDK. |
| `BindingResult` | Package source and adapters boot-extension test. | internal package wiring | Move to SDK only if retained in extension-safe `KeyBinding` contract. |
| `bootExtensions` | Package source (`app`, `run`, `controller`) and adapters tests. | internal package wiring | Keep in adapters; it wires catalog activation to concrete registries. |
| `BootExtensionsOptions` | Package source only. | internal package wiring | Keep with `bootExtensions`; not SDK/catalog. |
| `BootExtensionsResult` | Package source only. | internal package wiring | Keep with `bootExtensions`; not SDK/catalog. |
| `buildActivityBarLine` | Package source (`core-chrome`) and adapters tests. | internal package wiring | Keep adapters-owned; not extension authoring API. |
| `canUseNanobossTui` | Package source and smoke test. | external contract | Keep as adapters environment probe unless public surface is narrowed later. |
| `ChromeContribution` | Package source, adapters tests, SDK re-export. | external contract | Move contract to SDK; adapters owns registry implementation. |
| `ChromeRenderContext` | Package source only. | external contract | Move with `ChromeContribution` if chrome contributions stay extension-facing. |
| `ChromeSlotId` | Package source, SDK re-export, docs/plans. | external contract | Move contract to SDK. |
| `createInitialUiState` | Package source and many adapters tests. | internal package wiring | Keep adapters-owned; tests can import internally if public surface is narrowed. |
| `createNanobossTuiTheme` | Public import from `resume.ts`; package source and tests. | external contract | Keep factory in adapters; move `NanobossTuiTheme` type to SDK. |
| `createNbCardV1Renderer` | Package source and catalog builtin dynamic import. | internal package wiring | Keep in adapters and move builtin extension definition to adapters. |
| `createTuiExtensionContextFactory` | Package source only. | internal package wiring | Keep in adapters boot layer; not extension authoring API. |
| `dispatchKeyBinding` | Package source and adapters tests. | internal package wiring | Keep adapters registry dispatcher; do not move to SDK. |
| `ExtensionsCardPayload` | Package source only. | internal package wiring | Keep with card formatter or internalize. |
| `formatExtensionsCard` | Package source (`controller`) and adapters tests. | internal package wiring | Keep current production formatter in adapters. |
| `formatExtensionsList` | No production caller beyond own module; adapters compatibility tests. | legacy/compatibility | Candidate for deletion in Phase 5 after confirming no out-of-tree compatibility requirement. |
| `FormRenderContext` | Package source and form-renderer tests. | internal package wiring | Keep adapters-owned; not part of current extension SDK. |
| `FormRenderer` | Package source and form-renderer tests. | internal package wiring | Keep adapters-owned unless forms become extension contributions later. |
| `FormRendererEditorLike` | No repo consumer. | accidental | Remove public re-export or keep only if a documented external form API is created. |
| `FrontendConnectionMode` | Public import from `src/options/frontend-connection.ts`; package source. | external contract | Keep in adapters public CLI option surface. |
| `FrontendContinuation` | Package source only. | internal package wiring | Keep adapters-owned; public re-export appears accidental. |
| `getActivityBarSegments` | Package source and adapters tests. | internal package wiring | Keep adapters registry API; public re-export not needed by extensions. |
| `getChromeContributions` | Package source and adapters tests. | internal package wiring | Keep adapters registry API; public re-export not needed by extensions. |
| `getFormRenderer` | Package source and form-renderer tests. | internal package wiring | Keep adapters registry API. |
| `getPanelRenderer` | Package source and adapters tests. | internal package wiring | Keep adapters registry API for runtime lookup/shadowing. |
| `isExitRequest` | Package source only (`controller`). | internal package wiring | Internalize with command parsing if public surface is narrowed. |
| `isExtensionsListRequest` | Package source only (`controller`). | internal package wiring | Internalize with command parsing if public surface is narrowed. |
| `isModelPickerRequest` | Package source only (`controller`). | internal package wiring | Internalize with command parsing if public surface is narrowed. |
| `isNewSessionRequest` | Package source only (`controller`). | internal package wiring | Internalize with command parsing if public surface is narrowed. |
| `KeyBinding` | Package source, adapters tests, SDK re-export. | external contract | Move an extension-safe contract to SDK; keep concrete dispatcher in adapters. |
| `KeyBindingAppHooks` | Package source and adapters tests. | internal package wiring | Do not move as-is; concrete app hooks are adapters internals. |
| `KeyBindingCategory` | Package source only. | external contract | Move with SDK `KeyBinding` if categories remain public. |
| `KeyBindingController` | Package source and adapters tests. | internal package wiring | Do not move as-is; define a narrower SDK command surface if needed. |
| `KeyBindingEditor` | Package source and adapters tests. | internal package wiring | Do not move as-is; concrete editor access is adapters-owned. |
| `KeyMatcher` | Package source only. | external contract | Move only after replacing pi-tui `KeyId` with an SDK-owned structural key type. |
| `keyMatches` | Package source and adapters tests. | internal package wiring | Keep adapters dispatcher helper. |
| `listActivityBarSegments` | Package source and adapters tests. | internal package wiring | Keep adapters registry API; not needed outside adapters. |
| `listChromeContributions` | Package source and adapters tests. | internal package wiring | Keep adapters registry API; not needed outside adapters. |
| `listFormRenderers` | Package source and form-renderer tests. | internal package wiring | Keep adapters registry API. |
| `listKeyBindings` | Package source and adapters tests. | internal package wiring | Keep adapters registry API; not needed by extensions. |
| `listPanelRenderers` | Package source only. | internal package wiring | Keep or internalize; no current external consumer. |
| `LOCAL_TUI_COMMANDS` | Package source only. | internal package wiring | Internalize if command autocomplete stays adapters-owned. |
| `NanobossAppView` | Package source and adapters view/chrome/panel tests. | internal package wiring | Keep adapters concrete view; not SDK/catalog. |
| `NanobossTuiApp` | Package source and adapters app tests. | external contract | Keep adapters app API used by `runTuiCli`. |
| `NanobossTuiAppParams` | Package source only. | external contract | Keep with `NanobossTuiApp` if app remains public. |
| `NanobossTuiController` | Package source and controller/extensions tests. | internal package wiring | Keep adapters concrete controller; not SDK/catalog. |
| `NanobossTuiControllerDeps` | Package source and controller/extensions tests. | internal package wiring | Keep adapters test/runtime seam. |
| `NanobossTuiControllerParams` | Package source only. | internal package wiring | Keep with controller or internalize. |
| `NanobossTuiTheme` | Package source, SDK re-export, tests. | external contract | Move structural type to SDK; adapters keeps theme implementation. |
| `NbCardTone` | Package source only. | internal package wiring | Keep adapters core panel implementation detail. |
| `NbCardV1Payload` | Package source only. | internal package wiring | Keep adapters core panel contract unless procedure SDK owns panel payload docs. |
| `NbCardV1PayloadType` | Package source only. | internal package wiring | Keep adapters core panel schema. |
| `nbCardV1Tone` | Package source only. | internal package wiring | Keep adapters core panel helper. |
| `PanelRenderContext` | Package source only. | external contract | Move with `PanelRenderer` to SDK after deciding render-result abstraction. |
| `PanelRenderer` | Package source, adapters tests, SDK re-export. | external contract | Move contract to SDK; adapters owns registry and concrete renderers. |
| `parseModelSelectionCommand` | Package source and command tests. | internal package wiring | Internalize unless command parser API is intentionally public. |
| `parseToolCardThemeCommand` | Package source and command tests. | internal package wiring | Internalize unless command parser API is intentionally public. |
| `promptForStoredSessionSelection` | Public import from `resume.ts`; package source. | external contract | Keep adapters resume overlay API. |
| `promptWithSelectList` | Package source only. | internal package wiring | Keep adapters overlay helper; public re-export may be narrowed later. |
| `reduceUiState` | Package source and many adapters tests. | internal package wiring | Keep adapters reducer; not SDK/catalog. |
| `registerActivityBarSegment` | Package source and tests only; no external production import. | internal package wiring | Keep module-level registry in adapters only; extensions use `ctx.registerActivityBarSegment`. |
| `registerChromeContribution` | Package source and tests only; no external production import. | internal package wiring | Keep module-level registry in adapters only; extensions use `ctx.registerChromeContribution`. |
| `registerFormRenderer` | Package source and form-renderer tests. | internal package wiring | Keep adapters registry API; not extension SDK. |
| `registerKeyBinding` | Package source and tests only; no external production import. | internal package wiring | Keep module-level registry in adapters only; extensions use `ctx.registerKeyBinding`. |
| `registerPanelRenderer` | Package source, catalog builtin dynamic import path, tests. | internal package wiring | Keep module-level registry in adapters; remove catalog dependency by moving builtin implementation to adapters. |
| `renderNbCardV1Markdown` | Package source only. | internal package wiring | Keep adapters core panel helper. |
| `runTuiCli` | Public import from `cli.ts` and `resume.ts`; tests. | external contract | Keep adapters public CLI entrypoint. |
| `RunTuiCliDeps` | Package source only. | external contract | Keep with `runTuiCli` testing/integration seam. |
| `RunTuiCliParams` | Package source only. | external contract | Keep with `runTuiCli`. |
| `SelectOverlay` | Package source and select-overlay test. | internal package wiring | Keep adapters overlay implementation; public re-export can be narrowed later. |
| `SelectOverlayOptions` | Package source only. | internal package wiring | Keep with `SelectOverlay` or internalize. |
| `SessionResponse` | Package source, HTTP adapter source, controller test. | external contract | Keep until HTTP/TUI controller response contract is relocated or deduplicated. |
| `shouldDisableEditorSubmit` | Package source and command tests. | internal package wiring | Internalize unless command parser helpers remain public. |
| `ToolCardThemeMode` | Package source only. | external contract | Keep with theme factory/options; could move to SDK only if extensions configure themes. |
| `TranscriptComponent` | Package source only. | internal package wiring | Keep concrete view internal; public re-export appears accidental. |
| `TuiExtensionBootLog` | Package source only. | internal package wiring | Keep with `bootExtensions`. |
| `TuiExtensionBootLogLevel` | Package source only. | internal package wiring | Keep with `bootExtensions`. |
| `TuiExtensionContextFactoryDeps` | Package source only. | internal package wiring | Keep adapters test seam; not SDK/catalog. |
| `UiAction` | Package source only. | internal package wiring | Keep adapters reducer action type; not SDK/catalog. |
| `UiInputDisabledReason` | Package source only. | internal package wiring | Keep adapters state detail; not SDK/catalog. |
| `UiPanel` | Package source only. | internal package wiring | Keep adapters state detail; not SDK/catalog. |
| `UiPendingPrompt` | Package source only. | internal package wiring | Keep adapters controller state detail; not SDK/catalog. |
| `UiProcedurePanel` | Package source only. | internal package wiring | Keep adapters transcript/panel state detail; not SDK/catalog. |
| `UiState` | Package source, adapters tests, SDK re-export. | external contract | Do not move full type; replace SDK exposure with narrower read-only extension state contract. |
| `UiToolCall` | Package source only. | internal package wiring | Keep adapters transcript state detail; not SDK/catalog. |
| `UiTranscriptItem` | Package source only. | internal package wiring | Keep adapters transcript state detail; not SDK/catalog. |
| `UiTurn` | Package source only. | internal package wiring | Keep adapters transcript state detail; not SDK/catalog. |
| `unregisterPanelRenderer` | Package source only (`boot-extensions` shadowing). | internal package wiring | Keep adapters registry helper for boot shadowing; not needed outside adapters. |

TUI extension SDK public exports:

| Export | Consumer evidence | Class | Recommended disposition |
| --- | --- | --- | --- |
| `ActivityBarSegment` | Re-exported from adapters; used by SDK context shape. | external contract | Own in SDK; remove adapters import. |
| `ChromeContribution` | Re-exported from adapters; used by SDK context shape. | external contract | Own in SDK; remove adapters import. |
| `ChromeSlotId` | Re-exported from adapters. | external contract | Own in SDK with chrome contribution contract. |
| `Component` | SDK placeholder; fixture extension returns structural values. | external contract | Keep SDK-owned render-result abstraction; document `unknown` if intentional. |
| `KeyBinding` | Re-exported from adapters; used by SDK context shape. | external contract | Own an extension-safe version in SDK; avoid concrete app hooks leaking as-is. |
| `NanobossTuiTheme` | Re-exported from adapters; exposed as `ctx.theme`. | external contract | Own structural theme type in SDK; adapters implementation conforms to it. |
| `PanelRenderer` | Re-exported from adapters; used by extensions and catalog builtin. | external contract | Own in SDK with SDK render-result type. |
| `TuiExtension` | Used by catalog source, adapters tests, fixture extension, README. | external contract | Keep SDK-owned authoring contract. |
| `TuiExtensionContext` | Used by adapters boot, catalog registry, tests, README. | external contract | Keep SDK-owned activation context. |
| `TuiExtensionLogger` | Used by adapters boot. | external contract | Keep SDK-owned context sub-contract. |
| `TuiExtensionMetadata` | Used by catalog source, fixture extension, README. | external contract | Keep SDK-owned metadata contract. |
| `TuiExtensionScope` | Used by catalog source and tests. | external contract | Keep SDK-owned scope contract. |
| `UiState` | Re-exported from adapters; indirectly used by binding/panel/chrome contracts. | external contract | Replace full adapters state with narrower SDK-owned extension state contract. |

TUI extension catalog public exports:

| Export | Consumer evidence | Class | Recommended disposition |
| --- | --- | --- | --- |
| `assertTuiExtension` | Catalog source only (`disk-loader`, `registry`). | internal package wiring | Internalize unless loader validation is intentionally public. |
| `discoverDiskTuiExtensions` | Catalog source only (`registry`). | internal package wiring | Keep catalog-owned discovery helper; public re-export optional. |
| `DiscoveredDiskTuiExtension` | Catalog source only. | internal package wiring | Keep with discovery helper or internalize. |
| `LoadableTuiExtensionRegistry` | Catalog source only (`builtins`, `registry`). | internal package wiring | Remove public need after moving builtins out of catalog. |
| `loadTuiExtensionFromPath` | Catalog source only (`registry`). | internal package wiring | Keep catalog-owned loader helper; public re-export optional. |
| `RegisteredTuiExtension` | Catalog source only (`registry`). | internal package wiring | Internalize registry entry shape. |
| `TuiExtensionActivationStatus` | Catalog source only through status type. | external contract | Keep as part of `TuiExtensionStatus`. |
| `TuiExtensionContextFactory` | Adapters boot source and catalog tests. | internal package wiring | Keep catalog/adapters integration contract. |
| `TuiExtensionContextFactoryParams` | Catalog source only. | internal package wiring | Keep with factory type or internalize if not imported. |
| `TuiExtensionContributionCounts` | Adapters boot source and catalog source. | external contract | Keep because adapters reports counts back to catalog/status. |
| `TuiExtensionRegistry` | Adapters boot/controller source and tests. | external contract | Keep catalog primary runtime API. |
| `TuiExtensionRegistryOptions` | Catalog source only. | external contract | Keep with registry constructor. |
| `TuiExtensionStatus` | Adapters app/controller/commands source. | external contract | Keep catalog status API for `/extensions` and app wiring. |

### Phase 2: make the SDK leaf-level

Likely implementation:

- Move extension-facing structural types from `adapters-tui` into
  `tui-extension-sdk` if they are pure contracts.
- Keep concrete implementations and module-level registries in `adapters-tui`.
- Have `adapters-tui` import SDK types instead of the SDK importing TUI types.
- Replace the SDK `Component = unknown` placeholder with either:
  - an SDK-owned structural render result type, or
  - an explicit `unknown` contract documented as intentional.

Acceptance:

- `packages/tui-extension-sdk/package.json` has no dependency on
  `@nanoboss/adapters-tui`.
- `packages/tui-extension-sdk/src/index.ts` has no `@nanoboss/adapters-tui`
  import.
- SDK tests still pass from the package directory.

### Phase 3: move builtin extension implementation out of catalog

Likely implementation:

- Keep catalog registry/discovery generic.
- Define the builtin `nanoboss-core-ui` extension in `adapters-tui`, because it
  depends on `createNbCardV1Renderer`.
- Let `adapters-tui` seed the catalog with builtin extensions during
  `bootExtensions`.
- Delete the dynamic `await import("@nanoboss/adapters-tui")` from
  `tui-extension-catalog/src/builtins.ts`, or delete that file if builtin
  loading becomes adapter-owned.

Acceptance:

- `tui-extension-catalog` has no dependency on `@nanoboss/adapters-tui`.
- `tui-extension-catalog` does not dynamically import `@nanoboss/adapters-tui`.
- Builtin `nb/card@1` registration still happens through the same activation
  path as profile/repo extensions.
- Existing panel renderer precedence tests still pass.

### Phase 4: put extension packages under dependency-direction validation

Actions:

- Add `tui-extension-sdk` and `tui-extension-catalog` to the primary
  `PACKAGE_NAMES` list in `tests/unit/package-dependency-direction.test.ts`.
- Remove or shrink `ADDITIONAL_WORKSPACE_PACKAGES`.
- Add their allowed layering:
  - `tui-extension-sdk -> []` or only lower-level pure packages if needed.
  - `tui-extension-catalog -> app-support, tui-extension-sdk`.
  - `adapters-tui -> tui-extension-catalog, tui-extension-sdk`.

Acceptance:

- The dependency-direction test validates all TUI extension packages.
- The allowed graph remains acyclic.
- There is no comment describing the TUI extension cycle as intentional.

### Phase 5: remove legacy and fallback extension paths

Review candidates:

- `formatExtensionsCommandLegacy` or equivalent legacy formatter in
  `packages/adapters-tui/src/commands.ts`.
- Tests that only preserve legacy one-line `/extensions` output.
- Any legacy continuation UI shim that is no longer reachable after
  `Continuation.ui` removal.
- Fallback panel rendering paths that can be replaced by explicit renderer
  registration failures.

Rules:

- Delete legacy code if no production caller uses it.
- Keep fallback display only when it protects user-visible transcript replay of
  already-persisted sessions.
- If a fallback remains, add a comment naming the concrete compatibility case
  and a test for that case.

Acceptance:

- No legacy extension formatter remains unless a production caller requires it.
- Remaining fallback paths have specific tests and comments.
- `rg "legacy|fallback|shim|compat" packages/adapters-tui packages/tui-extension-*`
  has no unexplained hits.

## Test strategy

Run during review:

```sh
bun test packages/tui-extension-sdk packages/tui-extension-catalog packages/adapters-tui
bun run typecheck:packages
bun test tests/unit/package-dependency-direction.test.ts
```

Run before commit:

```sh
bun run check:precommit
```

Additional tests likely needed:

- SDK smoke test proving extension authoring contracts compile without
  importing `adapters-tui`.
- Catalog test proving activation order and precedence without loading concrete
  TUI renderers.
- TUI boot test proving builtin `nb/card@1` is seeded and activated through the
  catalog path.
- Dependency-direction test update proving the cycle is gone.

## Risks

- Moving types from `adapters-tui` to the SDK may create churn in many TUI tests.
- Builtin extension relocation must preserve renderer shadowing semantics
  (`builtin -> profile -> repo`).
- Some compatibility paths may still support persisted transcript replay; those
  should be narrowed, not deleted blindly.
- If `PanelRenderer` currently depends on concrete pi-tui `Component`, the SDK
  may need a deliberate abstraction rather than a direct type move.

## Out of scope

- Redesigning TUI visuals.
- Changing extension discovery roots.
- Changing renderer ID naming conventions.
- Making third-party extensions publishable outside this monorepo.
- Refactoring unrelated TUI reducer/controller behavior except where it touches
  extension boot, extension status, or extension fallback paths.

## Final acceptance criteria

- `tui-extension-sdk` is a leaf package.
- `tui-extension-catalog` does not depend on `adapters-tui`.
- `adapters-tui` is the concrete runtime that wires SDK contracts and catalog
  discovery into TUI registries.
- The TUI extension packages are validated by the package dependency-direction
  test.
- The extension boot path has one clear path for builtin, profile, and repo
  extensions.
- Legacy/fallback extension paths are either deleted or explicitly justified by
  tests.
