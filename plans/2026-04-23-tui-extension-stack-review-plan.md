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
