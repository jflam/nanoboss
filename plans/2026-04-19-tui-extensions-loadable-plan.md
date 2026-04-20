# TUI extensions as loadable modules plan

Follow-up to `2026-04-19-tui-runtime-extensibility-primitives-plan.md`.

## Problem

The extensibility primitives plan introduces four registries on the TUI side
(input bindings, chrome slots, activity-bar segments, panel renderers) and an
opaque UI payload channel end-to-end. What it does **not** do is make those
registries populatable from anywhere other than core code compiled into
`@nanoboss/adapters-tui`. The registries are module-level; core registers its
own contributions at import time; a user cannot add a binding or a panel
renderer without patching the package.

That is the wrong shape. Nanoboss already solved this for procedures:

- `@nanoboss/procedure-catalog` discovers procedures from three tiers via
  `resolveWorkspaceProcedureRoots(cwd)` in
  `packages/app-support/src/procedure-paths.ts`:
  1. **Built-ins** compiled into the product (`packages/procedure-catalog/src/builtins.ts`).
  2. **Repo-scoped** — `<repo>/.nanoboss/procedures/`.
  3. **Profile-scoped** — `~/.nanoboss/procedures/`.
- Disk procedures are TypeScript modules compiled on the fly by
  `packages/procedure-catalog/src/disk-loader.ts` via a Bun build with the
  `typia-bun-plugin` into `~/.nanoboss/runtime/`, then imported as ESM.
- `ProcedureRegistry` in `packages/procedure-catalog/src/registry.ts`
  exposes `loadBuiltins()` + `loadFromDisk()` and deduplicates by name.

We want UI extensions to load the same way, in the same three tiers, and
populate the four registries from step-1/2/3 of the primitives plan. A new
keybinding, a new activity-bar segment, a new panel renderer, or a new chrome
contribution should be a file the user drops in
`~/.nanoboss/extensions/` or `<repo>/.nanoboss/extensions/` and Nanoboss
picks it up at TUI start without a core code change.

## Proposed approach

Add an **extension catalog** package that mirrors `procedure-catalog` in
responsibility and layering, but targets TUI registries instead of
procedures. It discovers extensions from three tiers, compiles and imports
each one through the same Bun-runtime path we already use for procedures,
and calls each extension's `activate(ctx)` hook to let it register bindings,
segments, chrome contributions, and panel renderers.

The catalog runs at TUI startup **before** `NanobossAppView` is constructed,
so every extension has a chance to register before the first render.

**Precedence.** Repo extensions override profile extensions override
built-ins, matched by extension `name` (same rule as procedures
deduplicate by name in `ProcedureRegistry`). Within a tier, load order is
stable (alphabetical by entry path).

**Scope.** This plan adds the loading and activation plumbing and the
extension contract. It does **not** replace the primitives plan — it assumes
steps 1–3 of that plan have landed (or will land first) and the registries
they introduce are the activation surface.

## Design

### 1. Extension file layout

Mirror the procedures layout:

```
<repo>/.nanoboss/extensions/<name>.ts
<repo>/.nanoboss/extensions/<name>/index.ts
~/.nanoboss/extensions/<name>.ts
~/.nanoboss/extensions/<name>/index.ts
```

Each file default-exports a `TuiExtension`:

```ts
// packages/tui-extension-sdk/src/index.ts
export interface TuiExtensionMetadata {
  name: string;                       // "acme-files-dashboard"
  version: string;                    // "1.0.0"
  description: string;
  // optional capability declarations, used by the catalog for loading order
  // and by the future "what does this extension provide" surface.
  provides?: {
    bindings?: string[];              // binding ids
    chromeContributions?: string[];   // chrome contribution ids
    activityBarSegments?: string[];   // segment ids
    panelRenderers?: string[];        // rendererId values (e.g. "acme/files-dashboard@1")
  };
}

export interface TuiExtension {
  metadata: TuiExtensionMetadata;
  activate(ctx: TuiExtensionContext): void | Promise<void>;
  deactivate?(ctx: TuiExtensionContext): void | Promise<void>;
}
```

`TuiExtensionContext` exposes the four registries and nothing else (no
direct access to mutate `UiState`, no access to the HTTP client):

```ts
export interface TuiExtensionContext {
  readonly extensionName: string;
  readonly scope: "builtin" | "profile" | "repo";
  readonly theme: NanobossTuiTheme;

  registerKeyBinding(binding: KeyBinding): void;
  registerChromeContribution(contribution: ChromeContribution): void;
  registerActivityBarSegment(segment: ActivityBarSegment): void;
  registerPanelRenderer<T>(renderer: PanelRenderer<T>): void;

  // Logger that routes into the same status-line pathway core uses, so
  // extension errors surface to the user without crashing the TUI.
  readonly log: {
    info(text: string): void;
    warning(text: string): void;
    error(text: string): void;
  };
}
```

Every `register*` call namespaces the contribution by `extensionName`
(`"${extensionName}/${id}"`) so different extensions cannot collide on ids.

### 2. New package: `@nanoboss/tui-extension-catalog`

Structurally parallel to `@nanoboss/procedure-catalog`:

```
packages/tui-extension-catalog/src/
  builtins.ts           // compiled-in extensions (e.g., "nanoboss-core-ui")
  disk-loader.ts        // discover + compile + import via Bun runtime
  loadable-registry.ts  // types shared with disk loading
  paths.ts              // reuse or parallel app-support helpers
  registry.ts           // TuiExtensionRegistry, activate(ctx) orchestration
  index.ts
```

`resolveWorkspaceExtensionRoots(cwd, profileExtensionRoot?)` in
`@nanoboss/app-support/src/extension-paths.ts` should mirror the existing
`resolveWorkspaceProcedureRoots(...)`:

- `resolveRepoExtensionRoot(cwd)` → `<repo>/.nanoboss/extensions`.
- `resolveProfileExtensionRoot()` → `~/.nanoboss/extensions`.
- `resolveWorkspaceExtensionRoots(cwd)` → deduplicated `[localRoot,
  profileRoot]`.

The registry:

```ts
class TuiExtensionRegistry {
  constructor(options: { cwd?: string; extensionRoots?: string[]; profileExtensionRoot?: string });
  loadBuiltins(): void;
  loadFromDisk(): Promise<void>;
  listMetadata(): TuiExtensionMetadata[];
  async activateAll(ctx: BuildContextFn): Promise<void>;   // calls activate per extension
  async deactivateAll(): Promise<void>;
}
```

Loading precedence is the same as procedures: repo > profile > builtin by
`metadata.name`; later loaders shadow earlier ones.

### 3. Disk loader — reuse what procedures already do

The Bun runtime compile pipeline in
`packages/procedure-catalog/src/disk-loader.ts` already solves the hard
parts: it walks a root directory, reads a `metadata` export statically,
builds the module with `typia-bun-plugin` into `~/.nanoboss/runtime/`, and
imports the result via `pathToFileURL`.

We should **not** fork that logic. Two options:

- **Option A (preferred).** Extract the generic bits of `disk-loader.ts`
  into a new `@nanoboss/app-support` or `@nanoboss/disk-module-loader`
  utility module (`discoverDiskModules`, `loadDiskModule`), parameterized
  by a predicate ("is this default export the right shape?"). Procedures
  and extensions both consume that utility.
- **Option B.** Duplicate the loader in
  `@nanoboss/tui-extension-catalog` for now and extract later.

Option A is a small refactor (the procedure-specific parts are
`assertProcedure` and `resolveProcedureEntryRelativePath`) and worth doing
once. It keeps one compile/runtime path for user-authored TS across the
product.

The compiled-module cache at `~/.nanoboss/runtime/` can stay shared
between procedures and extensions — they are independent modules with
independent cache keys (hashes of source + deps).

### 4. Activation order and the TUI boot sequence

Today, `@nanoboss/adapters-tui` core bindings and components are wired at
module init. After step 1/2 of the primitives plan, they register into
module-level registries during `core-bindings.ts` / `core-chrome.ts` import.

The boot sequence becomes:

1. **Import core** — registers built-in bindings, chrome contributions,
   activity-bar segments, and the core panel renderers (`nb/card@1`,
   `nb/simplify2-*@1`).
2. **Build `TuiExtensionRegistry`** with `cwd` + default roots.
3. **`registry.loadBuiltins()`** — activates any UI extensions that are
   shipped with Nanoboss itself (reserved; empty list initially).
4. **`registry.loadFromDisk()`** — discovers disk extensions.
5. **`registry.activateAll(ctx)`** — each extension's `activate(ctx)`
   gets a `TuiExtensionContext` that writes into the same module-level
   registries core uses. Later tiers shadow earlier ones by extension
   name; contribution ids are namespaced per extension so two extensions
   can coexist without collision.
6. **Construct `NanobossAppView`** — first render iterates registries;
   everything that was registered above shows up.

**Failure isolation.** If an extension's `activate` throws, log the error
via `ctx.log.error`, mark the extension as failed, continue with the
others, and surface a one-line status message to the user ("1 extension
failed to activate — `/help` for details"). A broken third-party
extension must not brick the TUI.

### 5. Panel renderers as the primary extension surface

The most valuable thing extensions ship is **panel renderers**. A procedure
emits `ui.panel({ rendererId: "acme/files-dashboard@1", payload: { … } })`;
an extension registers the renderer for `"acme/files-dashboard@1"`. They
reach each other entirely through `rendererId` — no compile-time coupling.

Two packaging conventions we should document:

- **Procedure + renderer in one extension.** A repo-scoped extension can
  ship both the procedure (dropped into `.nanoboss/procedures/`) and the
  renderer (dropped into `.nanoboss/extensions/`). Repo-scoped by nature:
  the pair travels with the project.
- **Renderer-only extensions.** Profile-scoped renderers for ecosystem
  `rendererId`s (e.g., `ghcli/pr-card@1`) live under
  `~/.nanoboss/extensions/` and apply to any project the user opens.

The `registerPanelRenderer` call should validate that `rendererId` is
not already registered by a higher-precedence tier before shadowing — i.e.
repo > profile > builtin wins. Diagnostics on conflict go through
`ctx.log.warning`.

### 6. Contract between extensions and the TUI

Extensions depend on a new narrow SDK package
`@nanoboss/tui-extension-sdk` that re-exports only the types they need:

```ts
export type {
  TuiExtension,
  TuiExtensionMetadata,
  TuiExtensionContext,
  KeyBinding,
  ChromeContribution,
  ChromeSlotId,
  ActivityBarSegment,
  PanelRenderer,
  NanobossTuiTheme,
  UiState,                             // read-only type
  Component,                           // from pi-tui re-export
} from "@nanoboss/adapters-tui";       // internally; SDK hides the source package
```

The SDK does **not** re-export the registries themselves. Extensions never
import `registerKeyBinding` directly — they receive the equivalent via
`ctx.*` at activation. This keeps a clear boundary: "the SDK is types and
helpers; the context is the only way to mutate runtime state."

### 7. Discoverability and introspection

Add a slash command `/extensions` that prints the current
`TuiExtensionRegistry.listMetadata()` with scope + activation status +
contribution counts. Parallel to today's `/help` and `/model`.

Add a new panel in the `ctrl+h` overlay (after step 1 of the primitives
plan) listing disabled extensions with the reason (typically
`activate` threw).

## Touch points

- **New package** `packages/tui-extension-sdk/` — re-export types.
- **New package** `packages/tui-extension-catalog/` — registry + disk
  loader + builtins placeholder.
- **`@nanoboss/app-support`** — add `extension-paths.ts` parallel to
  `procedure-paths.ts` (`resolveRepoExtensionRoot`,
  `resolveProfileExtensionRoot`, `resolveWorkspaceExtensionRoots`).
- **`@nanoboss/procedure-catalog`** — refactor reusable bits of
  `disk-loader.ts` out for shared use (optional; otherwise duplicate).
- **`@nanoboss/adapters-tui`** — add a `bootExtensions(cwd)` step to
  the controller/app startup; expose the four registries' `register*`
  functions via `TuiExtensionContext`; namespace ids per extension;
  add `/extensions` slash command; add failure-isolation logging.

## Tests

- `tui-extension-catalog` package tests (mirror `procedure-catalog`
  tests):
  - discovers extensions from repo root.
  - discovers extensions from profile root.
  - repo shadows profile by `metadata.name`.
  - broken `activate` is isolated; other extensions still load.
  - `rendererId` conflict across tiers: higher tier wins, lower tier is
    logged as shadowed.
- `adapters-tui` integration tests:
  - a fixture extension registers a keybinding; dispatch invokes it.
  - a fixture extension registers a chrome contribution; the slot
    renders it.
  - a fixture extension registers a panel renderer; a procedure emitting
    `ui_panel` with the matching `rendererId` renders through it.
- End-to-end fixture:
  - `fixtures/extensions/acme-hello/` contains a `.nanoboss/extensions`
    entry that adds a keybinding and a chrome contribution; TUI boot
    with that cwd exercises the full discover → compile → activate →
    render path.

## Rollout order (todos)

1. Extract shared disk-module loader helpers from
   `@nanoboss/procedure-catalog` into `@nanoboss/app-support` (or a new
   small package). Keep procedure-catalog as a consumer; no behavior
   change.
2. Add `extension-paths.ts` in `@nanoboss/app-support`.
3. Create `@nanoboss/tui-extension-sdk` as a types-only re-export
   package.
4. Create `@nanoboss/tui-extension-catalog` with
   `TuiExtensionRegistry`, disk loader, empty builtins list.
5. Wire `bootExtensions(cwd)` into the TUI controller/app startup; add
   `TuiExtensionContext` and the four `register*` namespacing wrappers.
6. Port one core panel renderer (`nb/card@1`) from "registered by core
   module import" to "registered as a builtin extension" to prove the
   builtin tier works end-to-end without a behavior change.
7. Add the `/extensions` slash command and the failure-isolation status
   line.
8. Add the end-to-end fixture extension and document the layout in
   `README.md`.

Steps 1–5 are infrastructure with no user-visible change. Steps 6–8 turn
it into a feature users can discover and use.

## Manual testing guide

Use this section to sanity-check the extension catalog end-to-end without
touching any automated tests.

### 0. What is actually migrated as a builtin extension

Per step 6, **only `nb/card@1`** (the card panel renderer) has been ported
from "registered at core module import" to "registered as a builtin
extension" (`nanoboss-core-ui` in
`packages/tui-extension-catalog/src/builtins.ts`). The step's goal was to
prove the builtin tier works without a behavior change — not to relocate
every core contribution.

The following core contributions are **still registered at module-import
time** inside `@nanoboss/adapters-tui` and were intentionally not moved:

- **Keybindings / help overlay** — `src/core-bindings.ts` (drives the
  `ctrl+h` help overlay via `listKeyBindings()`).
- **Status / footer / header chrome** — `src/core-chrome.ts`.
- **Activity-bar segments** (agent, model, token usage) —
  `src/core-activity-bar.ts`.
- **Other core panel renderers** (`nb/simplify2-*@1`, etc.) —
  `src/core-panels.ts`.

A follow-up plan can migrate any of these if we want them to go through
the builtin → profile → repo precedence pipeline. Extensions can already
**add** new bindings / chrome / segments / renderers today; they just
can't yet shadow the core ones by name.

### 1. Prerequisites

```bash
bun install
bun run build
bun test                        # compact unit + e2e, should be green
bun run test:packages           # per-package tests
```

The extension-specific tests to look at if something breaks:

```bash
bun test packages/tui-extension-catalog/tests
bun test packages/adapters-tui/tests/tui-boot-extensions.test.ts
bun test packages/adapters-tui/tests/tui-fixture-extension.test.ts
bun test packages/adapters-tui/tests/tui-extensions-command.test.ts
```

### 2. Smoke-test the fixture extension from the CLI

The repo already ships a fixture at
`tests/fixtures/extensions/acme-hello/.nanoboss/extensions/acme-hello.ts`
— point the TUI at that cwd and boot it:

```bash
cd tests/fixtures/extensions/acme-hello
bun --cwd "$(git rev-parse --show-toplevel)" run nanoboss.ts cli
```

Or from the repo root:

```bash
(cd tests/fixtures/extensions/acme-hello && bun "$OLDPWD"/nanoboss.ts cli)
```

Inside the TUI:

1. Type `/extensions` and press enter. You should see at least:
   - `nanoboss-core-ui` — scope `builtin`, status `active`, 1 renderer.
   - `acme-hello` — scope `repo`, status `active`, 1 binding, 1 chrome
     contribution.
2. Type `/help` (or press `ctrl+h`) — confirm the help overlay still
   renders. Core bindings come from `core-bindings.ts`; extension
   bindings appear under their namespaced ids (`acme-hello/greet`).
3. Watch the footer — the fixture's `acme-hello/badge` contribution is
   rendered into the `footer` slot.

### 3. Exercise the profile tier

Drop a trivial extension into `~/.nanoboss/extensions/` and restart:

```bash
mkdir -p ~/.nanoboss/extensions
cat > ~/.nanoboss/extensions/hello-profile.ts <<'EOF'
import type { TuiExtension, TuiExtensionMetadata } from "@nanoboss/tui-extension-sdk";

export const metadata: TuiExtensionMetadata = {
  name: "hello-profile",
  version: "0.0.1",
  description: "Profile-tier sanity extension",
};

const extension: TuiExtension = {
  metadata,
  activate(ctx) {
    ctx.log.info("hello-profile activated from " + ctx.scope);
  },
};

export default extension;
EOF

bun run nanoboss.ts cli
```

Inside the TUI, `/extensions` should list `hello-profile` with scope
`profile`. The info-log line should appear on the status line during
boot.

### 4. Verify precedence (repo shadows profile)

With `~/.nanoboss/extensions/hello-profile.ts` still in place, add a
same-name extension in the current repo:

```bash
mkdir -p .nanoboss/extensions
cp ~/.nanoboss/extensions/hello-profile.ts .nanoboss/extensions/hello-profile.ts
# edit description to "Repo-tier override" so you can tell them apart
```

Restart the TUI. `/extensions` should show **one** `hello-profile`
entry, scope `repo`, description "Repo-tier override". The profile
copy is silently shadowed.

Clean up:

```bash
rm .nanoboss/extensions/hello-profile.ts
rm ~/.nanoboss/extensions/hello-profile.ts
```

### 5. Verify failure isolation

Drop a broken extension next to the fixture:

```bash
cat > ~/.nanoboss/extensions/boom.ts <<'EOF'
import type { TuiExtension, TuiExtensionMetadata } from "@nanoboss/tui-extension-sdk";
export const metadata: TuiExtensionMetadata = {
  name: "boom", version: "0.0.1", description: "Always throws",
};
const extension: TuiExtension = {
  metadata,
  activate() { throw new Error("intentional test failure"); },
};
export default extension;
EOF
```

Restart the TUI. Expected:

- A status-line line similar to
  `[extensions] 1 extension(s) failed to activate`.
- `/extensions` shows `boom` with status `failed` and the error
  message.
- `nanoboss-core-ui` and `acme-hello` (if still present) remain `active`
  — the TUI did **not** crash.

Clean up: `rm ~/.nanoboss/extensions/boom.ts`.

### 6. Verify the builtin card renderer still works

Run any procedure that emits a `ui.panel({ rendererId: "nb/card@1", …
})` (most interactive procedures do). The card should render exactly
as before — this is the regression check for step 6's builtin-tier
migration. If cards render, the `nanoboss-core-ui` builtin extension
activation path is working.

### 7. Inspect the on-disk compile cache (optional)

Compiled extension modules land under
`~/.nanoboss/runtime/` alongside compiled procedures. Delete that
directory to force a clean re-compile:

```bash
rm -rf ~/.nanoboss/runtime
```

Boot the TUI again and confirm `/extensions` still lists everything —
this exercises the full discover → compile → import → activate path
from cold cache.

## Non-goals

- **Sandboxing.** Extensions run in-process with the same privileges as
  core; they are trusted code the user chose to install. If we ever want
  untrusted extensions, that is a dedicated future plan (likely a
  worker/VM isolate story — out of scope here).
- **Settings per extension.** Tracked as an open question in the
  primitives plan. Extensions can read `process.env` and their own disk
  files today if needed; a first-class settings API is a future plan.
- **Hot-reload at runtime.** v1 requires restarting the TUI to pick up
  a new or modified extension, matching the current procedure behavior.
  Hot-reload is worth doing later but not in scope here.
- **Remote extensions.** v1 loads only from the three local tiers. A
  registry/distribution story (similar to npm) is a separate plan.
- **Non-TUI frontends.** The catalog is TUI-scoped. If we ever build a
  second frontend, the catalog shape transfers, but the contribution
  types (chrome slots, activity-bar segments) are TUI-specific.

## Open questions

- **`metadata` constraints for static discovery.** Procedures rely on a
  grep-able `metadata` export in the source file so discovery does not
  have to execute the module. Do we want the same for extensions (cheap
  discovery; restricts what `metadata` can reference) or allow arbitrary
  imports in the metadata declaration (richer but requires executing the
  module to list it)? Recommend static-metadata for parity with
  procedures.
- **Extension disable list.** A config file (`~/.nanoboss/extensions.json`
  or `.nanoboss/extensions.json`) with `{ disabled: ["acme-hello"] }`
  for skipping a specific extension without deleting the file. Worth
  adding in step 7.
- **Per-workspace activation.** Do profile extensions activate in every
  workspace, or should there be an allowlist per workspace? Recommend
  "activate everywhere" by default, with the disable list above as the
  escape valve. Revisit if the ecosystem grows.
- **Interaction with the extensibility primitives plan.** This plan
  assumes steps 1–3 of the primitives plan have landed. If we land this
  plan first (which is technically possible with only the existing
  `UiApi.card` surface), the extension-SDK surface is thinner but the
  extension concept still works. Recommend landing the primitives plan
  first so there is a meaningful activation surface on day one.
