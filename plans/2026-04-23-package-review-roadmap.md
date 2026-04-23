# Package review roadmap

## Purpose

Nanoboss recently moved major runtime behavior into `packages/*`. The next
review pass should make those packages simpler to consume from the core app and
harder to misuse from each other.

The review objective is not just correctness. It is to reduce package coupling,
remove duplicate helper implementations, and delete fallback/legacy paths that
hide unclear ownership. The desired end state is that root `src/**/*.ts` stays a
thin wiring layer and each package has one clear reason to exist.

## Review principles

- Prefer one owner per behavior. If two packages implement the same helper, pick
  the lower-level owner and import it.
- Treat fallback paths as suspect. A fallback is acceptable only when there is a
  current, tested compatibility requirement.
- Treat architecture-test exceptions as review targets, not permanent design.
- Review package public surfaces, not only internals. A package that exports too
  much makes future simplification harder.
- Keep the core app simple. Root `src/**/*.ts` should call public package APIs;
  it should not know about package internals or competing execution paths.

## Prior review baseline

These packages already have substantial review or follow-up work in history:

- `@nanoboss/store`
  - `fb03118 Audit and document store persistence package`
  - `docs/store-package.md`
- `@nanoboss/agent-acp`
  - `f487828 Fix agent-acp session contract bugs`
  - `docs/agent-acp-package.md`
- `@nanoboss/procedure-sdk`
  - `e827312 Fix procedure-sdk contract gaps`
  - `5c36efb Add procedure-sdk public contract tests`
  - `3818ab9 Add procedure-sdk test:hermetic script`
  - `docs/procedure-sdk-package.md`
- `@nanoboss/procedure-engine`
  - `150898b Refine procedure engine review follow-ups`
  - `docs/procedure-engine-package.md`
- Package isolation and dependency checks
  - `plans/2026-04-16-pr7-post-extraction-convergence-review.md`
  - `plans/2026-04-16-package-isolation-plan.md`
  - `tests/unit/package-dependency-direction.test.ts`

Those reviews are not final, but the highest value now sits in newer packages
and in duplicate helper families that survived package extraction.

## Target order

### 1. TUI extension stack

Packages:

- `@nanoboss/adapters-tui`
- `@nanoboss/tui-extension-sdk`
- `@nanoboss/tui-extension-catalog`

Why this is first:

- `tests/unit/package-dependency-direction.test.ts` explicitly excludes the TUI
  extension packages because they are cyclic with `adapters-tui`.
- `tui-extension-sdk` imports types from `adapters-tui`.
- `adapters-tui` imports both extension packages.
- `tui-extension-catalog` dynamically imports `@nanoboss/adapters-tui` for the
  builtin `nb/card@1` renderer.
- This is the clearest architectural exception in the package graph.

Review goal:

- Make extension contracts leaf-level and cycle-free.
- Move concrete TUI implementation dependencies out of SDK/catalog where
  possible.
- Delete compatibility shims and fallback extension formatting that are no
  longer needed.

Specific plan:

- `plans/2026-04-23-tui-extension-stack-review-plan.md`

### 2. Cross-package duplicate helper sweep

Known candidates:

- `inferDataShape`
  - `packages/store/src/data-shape.ts`
  - `packages/procedure-engine/src/data-shape.ts`
  - embedded copy in `packages/app-runtime/src/memory-cards.ts`
- `summarizeText`
  - `packages/procedure-sdk/src/text.ts`
  - `packages/store/src/text.ts`
  - `packages/agent-acp/src/text.ts`
- `formatErrorMessage`
  - `packages/procedure-sdk/src/error-format.ts`
  - `packages/store/src/error-format.ts`
- `normalizeToolInputPayload` / `normalizeToolResultPayload`
  - `packages/app-runtime/src/tool-payload-normalizer.ts`
  - `packages/adapters-tui/src/tool-payload-normalizer.ts`
- `resolveSelfCommand`
  - `packages/procedure-engine/src/self-command.ts`
  - `packages/adapters-http/src/self-command.ts`
  - `packages/adapters-mcp/src/self-command.ts`
  - smaller local variant in `packages/agent-acp/src/runtime-capability.ts`

Review goal:

- Pick canonical owners.
- Remove all duplicate implementations.
- Extend architecture tests so these helper names cannot reappear in multiple
  package owners.

### 3. `@nanoboss/adapters-tui`

Why this is separate from target 1:

- The extension stack review is about package cycles and extension API shape.
- The full TUI adapter also contains state, reducer, controller, rendering,
  overlays, tool cards, fallback transcript text, and legacy UI compatibility.

Review goal:

- Separate frontend state/rendering policy from runtime/event translation.
- Delete legacy continuation and panel paths once the form/panel registries are
  the single path.
- Make fallback text behavior intentional and minimal.

### 4. `@nanoboss/app-runtime`

Review goal:

- Keep this package as orchestration and policy, not a helper owner.
- Audit `allowCurrentSessionFallback` and any other fallback path.
- Ensure runtime event projection is the single source of truth for adapters.
- Remove embedded data-shape and formatting helpers once target 2 lands.

### 5. Adapter boundary review

Packages:

- `@nanoboss/adapters-http`
- `@nanoboss/adapters-mcp`
- `@nanoboss/adapters-acp-server`

Review goal:

- Keep adapters as protocol translators.
- Centralize self-command resolution.
- Ensure adapters do not own runtime policy, fallback execution semantics, or
  persistence details.

### 6. `@nanoboss/app-support`

Review goal:

- Keep `app-support` low-level and cohesive.
- Prevent it from becoming a general helper bucket.
- Validate whether disk-module loading, path resolution, build info, repo
  artifacts, and workspace identity should remain together or split by owner.

### 7. Re-review foundational packages after cleanup

Packages:

- `@nanoboss/store`
- `@nanoboss/agent-acp`
- `@nanoboss/procedure-sdk`
- `@nanoboss/procedure-engine`
- `@nanoboss/procedure-catalog`
- `@nanoboss/contracts`

Review goal:

- Re-run focused reviews only after duplicate-helper and extension-cycle cleanup
  changes the dependency graph.
- Confirm prior package docs still describe reality.
- Remove compatibility language and tests that no longer represent supported
  behavior.

## Review workflow

For each target:

1. Map imports and declared dependencies for the package set.
2. Read package public barrels and package tests first.
3. Search for `fallback`, `legacy`, `deprecated`, `shim`, `compat`, duplicate
   helper names, and dynamic imports.
4. Identify concrete findings with file references.
5. Classify each finding as:
   - delete now
   - centralize now
   - split package/API
   - document as intentional
   - defer with explicit follow-up
6. Write or update a target-specific plan when changes are more than trivial.
7. Implement in small commits that preserve package tests and pre-commit checks.

## Acceptance criteria for the roadmap

- The TUI extension packages are included in dependency-direction validation or
  have a narrower, documented exception with a removal path.
- No known helper family has multiple package implementations unless there is a
  written reason and a test enforcing that reason.
- Root `src/**/*.ts` continues to use only public package APIs.
- Package public barrels expose intentional surfaces only.
- `bun run check:precommit` passes after each implementation batch.

## Out of scope

- Redesigning user-facing TUI layout or theme.
- Making packages independently publishable to npm.
- Replacing Bun workspace tooling.
- Large behavior changes to procedures unrelated to package ownership.
