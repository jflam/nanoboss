# Package isolation plan

## Purpose

PR #7 (`plans-2026-04-15-post-extraction-convergence`) converged the codebase
onto package-owned helpers and enforced the import topology with architecture
tests. What remains is to make each package *independently developable and
testable* rather than merely *source-isolated inside a monorepo*.

This plan executes the top two follow-ups called out in the PR #7 review
(`plans/2026-04-16-pr7-post-extraction-convergence-review.md`):

1. **Make packages independently testable** — each package owns a `tests/`
   directory, a `test` script, and a `typecheck` script; a root meta-task
   fans out across all packages.
2. **Add a package dependency-direction check** — an architecture test that
   enforces a declarative layering table and that every `@nanoboss/*` import
   in a package is declared in that package's `package.json`.

The outcome is: `cd packages/<name> && bun test` works for every package, and
a new cross-package import is impossible without either declaring the
dependency or updating the layering table.

## Current state (on `master` after PR #7)

- 12 packages under `packages/*/`.
- Every package except `@nanoboss/app-support` has a `tsconfig.json`
  that extends the root config.
- **No** package has `scripts`, no package has a `tests/` directory, no
  package has per-package `test`/`typecheck`/`build`/`lint` scripts.
- All 97 `tests/unit/*.test.ts` and 9 `tests/e2e/*.test.ts` files live at the
  repo root. Many unit tests already exercise a single package through its
  public entrypoint and can move with little or no change:
  - `agent-acp-package.test.ts`, `model-catalog.test.ts`,
    `token-metrics.test.ts`, `prompt-input.test.ts` → `agent-acp`
  - `procedure-engine-package.test.ts`, `error-format.test.ts`,
    `self-command.test.ts`, `execute-plan.test.ts`, `service.test.ts`,
    `registry.test.ts`, `context-api.test.ts`, `logger.test.ts`,
    `config.test.ts`, `dispatch-progress.test.ts`, `json-type.test.ts` →
    `procedure-engine`
  - `procedure-sdk-package.test.ts`, `tagged-json-line-stream.test.ts`,
    `text.test.ts`, `runtime-banner.test.ts` → `procedure-sdk`
  - `contracts.test.ts` → `contracts`
  - `settings.test.ts`, `session-store.test.ts`, `stored-sessions.test.ts`,
    `session-cleanup.test.ts`, `test-home-isolation.test.ts` → `store`
  - `procedure-disk-loader.test.ts`, `procedure-names.test.ts` →
    `procedure-catalog`
  - `install-path.test.ts`, `repo-fingerprint.test.ts`,
    `repo-artifacts.test.ts` (the package-scoped halves) → `app-support`
    (or `procedures/lib` when they are procedure helpers)
  - `mcp-*.test.ts`, `stdio-jsonrpc.test.ts`, `mcp-format.test.ts` →
    `adapters-mcp`
  - `http-client.test.ts`, `http-server-*.test.ts` → `adapters-http`
  - `tui-*.test.ts`, `select-overlay.test.ts` → `adapters-tui`
  - `acp-runtime.test.ts`, `acp-updates.test.ts`, `server.test.ts` →
    `adapters-acp-server`
  - `memory-cards.test.ts`, `runtime-mode.test.ts`,
    `runtime-capability.test.ts`, `mcp-server.test.ts`,
    `second-opinion-inherits-default-model.test.ts`,
    `token-usage.test.ts`, `default-memory-bridge.test.ts`,
    `current-session.test.ts` → `app-runtime`
- Several tests are genuinely *root-app* tests and stay in `tests/` at the
  root: `cli-options.test.ts`, `doctor.test.ts`,
  `http-server-options.test.ts`, `resume-options.test.ts`,
  `argv.test.ts`, `build-freshness.test.ts`, `build-size-report.test.ts`,
  `compact-test.test.ts`, `nanoboss.test.ts`, plus all of `tests/e2e/` and
  the whole family of architecture/convergence tests.
- The root `tsconfig.json` is the only `tsconfig` with the typia plugin
  configured and with `include` covering the whole workspace. Per-package
  tsconfigs currently just re-extend the root.

## Desired end state

After this plan is executed:

- Every package has its own `tests/` directory with the tests that are
  scoped to that package's public surface.
- Every package's `package.json` declares the following scripts:
  ```json
  {
    "scripts": {
      "test": "bun test",
      "typecheck": "tsc -p tsconfig.json --noEmit --pretty false"
    }
  }
  ```
  Plus, for packages that already need it, `lint`. `build` stays a root
  concern.
- `@nanoboss/app-support` has a `tsconfig.json` that matches the other
  packages, a declared `dependencies` block (even if empty), and its own
  `tests/`.
- Running `bun test` inside any package runs only that package's tests and
  resolves imports through the workspace `@nanoboss/*` aliases it needs.
- The root has a meta task that fans out: `bun run test:packages` runs
  `bun test` in every package; `bun run typecheck:packages` runs each
  package's tsc. Root `bun run test` still runs the root `tests/` suite
  (integration, e2e, architecture tests). Root `bun run typecheck`
  continues to typecheck the whole workspace through the root tsconfig so
  typia transforms and the full import graph are still validated.
- A new architecture test, `tests/unit/package-dependency-direction.test.ts`,
  enforces two invariants:
  1. For every package `P`, every `@nanoboss/<X>` import inside
     `packages/P/src/**/*.ts` and `packages/P/tests/**/*.ts` is declared in
     `packages/P/package.json`'s `dependencies`.
  2. The graph of declared `@nanoboss/*` dependencies matches an explicit
     `ALLOWED_LAYERING` table (declared in the test file) and is a DAG.

## Structural decisions

These decisions keep the work coherent and avoid scope creep.

### Rule 1: package tests exercise the public entrypoint only

Tests moved into `packages/<name>/tests/` must import only from
`@nanoboss/<name>` (for the package under test) and from other declared
`@nanoboss/*` dependencies. They must not reach into sibling
`packages/<other>/src/*` or into root `src/*`.

If a test currently reaches into root `src/*` or into sibling package
internals, that test stays in the root `tests/` directory and is treated as
an integration test, not a package test. This is explicit and
discretionary: the goal is not to move every test, it is to give each
package a credible isolated test suite.

### Rule 2: do not duplicate the typia transform setup

The root `tsconfig.json` carries the `typia/lib/transform` plugin. Rather
than copy that to each package tsconfig, per-package tsconfigs continue to
extend the root. Per-package `typecheck` scripts run `tsc -p
tsconfig.json`, which still resolves the plugin from the root via
`extends`. The `bunfig.toml` preload remains repo-global and is picked up
when `bun test` runs in any subdirectory of the workspace.

### Rule 3: `bun test` inside a package runs only that package's tests

Bun's test runner, invoked with no argument, walks the current working
directory for `*.test.ts`. With tests physically in `packages/<name>/tests/`
that is exactly what we want. No Bun config change is needed; the test
runner already respects cwd.

### Rule 4: the root is still the integration-test home

The following stay under root `tests/`:

- `tests/e2e/**` (all nine files)
- all architecture / convergence tests
  (`delete-remaining-src-core.test.ts`,
  `public-package-entrypoints.test.ts`,
  `root-owned-core-relocation.test.ts`, the four `*-convergence.test.ts`
  files, and the new `package-dependency-direction.test.ts`)
- every test that spans more than one package or exercises the root CLI
  (e.g. `nanoboss.test.ts`, `doctor.test.ts`, `cli-options.test.ts`)

This keeps per-package suites honest: they test packages, not the whole
app.

### Rule 5: the dependency-direction test is authoritative, not advisory

When the ALLOWED_LAYERING table and a package's declared dependencies
disagree with reality, the test fails. A PR that introduces a new edge
must either add it to the layering table (and justify the addition in the
PR description) or revert the edge.

## Frozen test-move map

This is the source of truth for which tests move into which package's
`tests/` directory. A test moves only if it already imports exclusively
from one `@nanoboss/<name>` or its declared dependencies. Tests that reach
into `src/*` or into sibling package internals stay put.

### `packages/contracts/tests/`
- `contracts.test.ts`

### `packages/procedure-sdk/tests/`
- `procedure-sdk-package.test.ts`
- `tagged-json-line-stream.test.ts`
- `text.test.ts`
- `runtime-banner.test.ts`

### `packages/agent-acp/tests/`
- `agent-acp-package.test.ts`
- `model-catalog.test.ts`
- `token-metrics.test.ts`
- `prompt-input.test.ts`

### `packages/store/tests/`
- `settings.test.ts`
- `session-store.test.ts`
- `stored-sessions.test.ts`
- `session-cleanup.test.ts`
- `test-home-isolation.test.ts`

### `packages/procedure-catalog/tests/`
- `procedure-disk-loader.test.ts`
- `procedure-names.test.ts`

### `packages/procedure-engine/tests/`
- `procedure-engine-package.test.ts`
- `error-format.test.ts`
- `self-command.test.ts`
- `execute-plan.test.ts`
- `service.test.ts`
- `registry.test.ts`
- `context-api.test.ts`
- `context-ui.test.ts`
- `logger.test.ts`
- `config.test.ts`
- `dispatch-progress.test.ts`
- `json-type.test.ts`

### `packages/app-support/tests/`
- `install-path.test.ts`
- `repo-fingerprint.test.ts` (the helper half in `@nanoboss/app-support`; if
  this test actually exercises the `procedures/lib/` copy, it stays at root
  or moves to `procedures/lib/tests`)

### `packages/adapters-mcp/tests/`
- `mcp-format.test.ts`
- `mcp-registration.test.ts`
- `mcp-stdio.test.ts`
- `stdio-jsonrpc.test.ts`

### `packages/adapters-http/tests/`
- `http-client.test.ts`
- `http-server-prompts.test.ts`
- `http-server-supervisor.test.ts`

### `packages/adapters-tui/tests/`
- `tui-app.test.ts`
- `tui-commands.test.ts`
- `tui-controller.test.ts`
- `tui-reducer.test.ts`
- `tui-views.test.ts`
- `tui-run.test.ts`
- `select-overlay.test.ts`
- `session-picker-format.test.ts`

### `packages/adapters-acp-server/tests/`
- `acp-runtime.test.ts`
- `acp-updates.test.ts`
- `server.test.ts`
- `frontend-events.test.ts`

### `packages/app-runtime/tests/`
- `memory-cards.test.ts`
- `runtime-mode.test.ts`
- `runtime-capability.test.ts`
- `mcp-server.test.ts`
- `second-opinion-inherits-default-model.test.ts`
- `token-usage.test.ts`
- `default-memory-bridge.test.ts`
- `current-session.test.ts`
- `call-agent-parse.test.ts`

### Stay at root (`tests/unit/`)
- all architecture/convergence tests
- `cli-options.test.ts`, `doctor.test.ts`,
  `http-server-options.test.ts`, `resume-options.test.ts`,
  `argv.test.ts`, `build-freshness.test.ts`, `build-size-report.test.ts`,
  `compact-test.test.ts`, `nanoboss.test.ts`,
  `resume.test.ts`, `ui-cli.test.ts`
- command-surface tests that invoke multiple packages:
  `autoresearch-command.test.ts`, `knowledge-base-commands.test.ts`,
  `model-command.test.ts`, `research-command.test.ts`,
  `simplify-command.test.ts`, `simplify2-command.test.ts`,
  `create-procedure.test.ts`, `procedure-dispatch-jobs.test.ts`,
  `default-history.test.ts`, `context-call-agent-session.test.ts`,
  `pre-commit-checks.test.ts`, `linter.test.ts`
- everything under `tests/e2e/`

Anything in the "stay at root" list that turns out to already be
package-local during implementation can be moved as a no-cost win, but the
plan does not require it.

## Declarative layering

`tests/unit/package-dependency-direction.test.ts` encodes the graph
verbatim. The starting ALLOWED_LAYERING (derived from today's declared
`dependencies`) is:

```
contracts             -> (none)
app-support           -> (none)
procedure-sdk         -> contracts
store                 -> contracts, procedure-sdk, app-support
agent-acp             -> contracts, procedure-sdk, store
procedure-catalog     -> procedure-sdk, app-support
procedure-engine      -> contracts, procedure-sdk, store, agent-acp,
                         procedure-catalog
adapters-mcp          -> contracts, procedure-sdk, procedure-engine,
                         app-runtime, app-support         (verify)
adapters-http         -> contracts, procedure-sdk, procedure-engine,
                         app-runtime                      (verify)
adapters-tui          -> contracts, procedure-sdk, procedure-engine,
                         store, agent-acp, app-runtime,
                         app-support                      (verify)
adapters-acp-server   -> contracts, agent-acp, adapters-mcp,
                         app-runtime, app-support, procedure-engine
app-runtime           -> contracts, procedure-sdk, procedure-engine,
                         procedure-catalog, agent-acp, store,
                         app-support
```

Edges flagged "(verify)" are based on today's declared deps; the
implementation step verifies them by scanning actual imports and correcting
the layering or the declared deps, whichever is wrong.

Edges the review called out as structurally questionable
(`procedure-engine → agent-acp`, `agent-acp → store`,
`adapters-acp-server → app-runtime`, `store → app-support`) are **locked in
as-is** by this plan. The dependency-direction test encodes reality, not a
redesign. Restructuring these edges is a separate future effort.

## Migration phases

### Phase 1: fix `@nanoboss/app-support` setup parity

Scope:

- Add `packages/app-support/tsconfig.json` extending `../../tsconfig.json`
  with `baseUrl` `../..` and `include: ["src/**/*.ts"]`, matching the other
  packages.
- Add an explicit (even if empty) `dependencies` block to
  `packages/app-support/package.json`. The `app-support` package currently
  has no workspace deps; if any `@nanoboss/*` imports appear during Phase 2
  they get declared here as part of that phase.
- Extend `public-package-entrypoints.test.ts` to assert every package
  (including `app-support`) has a `tsconfig.json` and a `scripts.test`
  entry.

Acceptance criteria:

- `ls packages/app-support/tsconfig.json` exists.
- `bun x tsc -p packages/app-support/tsconfig.json --noEmit` passes
  (still relies on root path map through `extends`).
- The parity assertion is added and passes.

### Phase 2: per-package `test` and `typecheck` scripts, empty `tests/` dirs

Scope:

- Add to every `packages/<name>/package.json`:
  ```json
  "scripts": {
    "test": "bun test",
    "typecheck": "tsc -p tsconfig.json --noEmit --pretty false"
  }
  ```
- Create an empty `packages/<name>/tests/` directory with a single
  placeholder `smoke.test.ts` that imports the public entrypoint and
  asserts one exported symbol is defined. This lets us land the scripts
  before any file moves and verifies the setup.
- Add root meta-scripts to `package.json`:
  ```json
  "test:packages": "bun run scripts/run-package-task.ts test",
  "typecheck:packages": "bun run scripts/run-package-task.ts typecheck"
  ```
  where `scripts/run-package-task.ts` iterates `packages/*/package.json`,
  runs the requested script in each workspace directory in parallel with a
  small concurrency cap, and aggregates pass/fail. (Keep it small — ~80
  LOC — and avoid dragging in a new dependency.)

Acceptance criteria:

- `bun run test:packages` runs 12 green smoke tests.
- `bun run typecheck:packages` passes across all 12 packages.
- The root `bun test` suite (now running 97 - N tests at first) still
  passes because file moves have not started.

### Phase 3: move package-local tests in per-package waves

Move tests in the order below so each wave can be validated and landed
independently. After each wave, run both `bun test` (root) and
`bun run test:packages` to confirm nothing broke.

Wave order (matches the layering so leaves move first):

1. `contracts`
2. `procedure-sdk`
3. `app-support`
4. `store`
5. `agent-acp`
6. `procedure-catalog`
7. `procedure-engine`
8. `adapters-mcp`
9. `adapters-http`
10. `adapters-tui`
11. `adapters-acp-server`
12. `app-runtime`

For each wave:

1. Move the files listed in the frozen test-move map into
   `packages/<name>/tests/`.
2. Rewrite their imports so every non-`node:` / non-`bun:` / non-test
   import is `@nanoboss/<dep>`; zero `../../src/...` and zero
   `packages/<other>/src/...` imports. If a test cannot be rewritten that
   way, it does not belong in the package suite — revert the move and
   leave the test at root.
3. Update any snippet references inside `public-package-entrypoints.test.ts`
   / `delete-remaining-src-core.test.ts` that pinned a canonical import
   path for a file that just moved.
4. Run `bun test` (root) + `bun run test:packages`.

Acceptance criteria (per wave and overall):

- Root `bun test` runs the remaining (non-moved) tests and passes.
- `cd packages/<name> && bun test` runs only the moved tests and passes.
- Package tsconfigs still typecheck (`bun run typecheck:packages`).
- `public-package-entrypoints.test.ts` still passes (path pins updated).

### Phase 4: add the dependency-direction architecture test

Scope:

- Create `tests/unit/package-dependency-direction.test.ts` with:
  - a const `ALLOWED_LAYERING: Record<PackageName, readonly PackageName[]>`
    matching the table in the "Declarative layering" section above;
  - a helper that reads `packages/<name>/package.json` and returns the set
    of declared `@nanoboss/*` deps;
  - a helper that walks `packages/<name>/src/**/*.ts` and
    `packages/<name>/tests/**/*.ts` with the TypeScript compiler API (same
    approach `public-package-entrypoints.test.ts` already uses) and
    collects every `@nanoboss/<x>` module specifier seen, static or
    dynamic;
  - three expectations per package:
    1. Every used `@nanoboss/*` is declared in `dependencies`.
    2. Every declared `@nanoboss/*` is in ALLOWED_LAYERING for that
       package.
    3. The layering graph as a whole is a DAG (depth-first cycle check).

- Update `public-package-entrypoints.test.ts` so it also asserts each
  package declares a `test` script and a `typecheck` script (parity).

Acceptance criteria:

- The new test file passes on the converged state.
- Deliberately introducing a disallowed edge (local verification only)
  fails the test with a clear message naming the source package, the
  unexpected target, and the file/line.

### Phase 5: enforce through pre-commit and document

Scope:

- Extend `scripts/precommit-check.ts` to run `bun run typecheck:packages`
  and `bun run test:packages` in addition to whatever it runs today, so
  package-isolation regressions are caught before push.
- Add a short "Package development" section to `README.md` (or
  `packages/README.md` if preferred) describing:
  - `cd packages/<name> && bun test`
  - `cd packages/<name> && bun run typecheck`
  - the ALLOWED_LAYERING table and how to add a new edge

Acceptance criteria:

- `bun run check:precommit` runs the new checks and passes.
- Docs describe the isolated workflow.

## Risks and mitigations

- **Typia-transformed tests break when moved.** `typia/lib/transform` is
  wired in the root tsconfig; `extends` should carry it down, but some
  tests that rely on `typia.json.schema<T>()` at test time may depend on
  path-map configuration that only fires when tsc sees the whole graph.
  Mitigation: the per-wave acceptance step runs the moved tests; if a
  typia-dependent test fails in a package suite, revert the move and
  leave it at root (Rule 1 — the test did not belong in a package suite).
- **Bun test discovery and CWD.** `bun test` with no arguments walks the
  cwd. If a package-relative `tests/` directory ever imports from a
  sibling package's `tests/` directory by accident, it will silently pull
  in extra tests. The dependency-direction test also scans `tests/**`, so
  such an import is caught there.
- **`run-package-task.ts` as a new hand-rolled script.** Keep it small and
  dependency-free (use `Bun.$` and `fs`). If it grows beyond ~100 LOC,
  replace it with a workspace runner rather than complicate the bespoke
  one.
- **ALLOWED_LAYERING drift.** The table duplicates information already in
  each `package.json`. The test enforces agreement in both directions, so
  drift fails CI rather than silently accumulating.

## Out of scope for this plan

- Redesigning the questionable dependency edges (`procedure-engine →
  agent-acp`, `agent-acp → store`, `adapters-acp-server → app-runtime`,
  `store → app-support`). This plan *encodes* the current graph; a
  follow-up plan can *restructure* it.
- Collapsing the two surviving helper duplicates (`toPublicRunResult`,
  `inferDataShape`). Tracked as follow-up #3 in the PR #7 review; this
  plan deliberately leaves it alone.
- Deleting empty `src/` directories (follow-up #5) and tightening the
  `src/core` regression test (follow-up #6).
- Making each package independently *publishable* (dist/, tsc project
  references, version bumps). The root bundler still owns builds.

## Final steady state

When the plan is done:

- Every package can be exercised by `cd packages/<name> && bun test`.
- Every package can be typechecked in place with `bun run typecheck`.
- Root meta-commands `bun run test:packages` and `bun run
  typecheck:packages` fan out across all 12 packages.
- The dependency graph among `@nanoboss/*` packages is a DAG matching a
  declarative table, and any new edge requires an explicit code change to
  that table.
- `@nanoboss/app-support` is set up like every other package.
- The root `tests/` directory contains architecture tests, root-app
  tests, and e2e tests — nothing package-local.

At that point the user-stated goal of PR #7 — "independent packages that
can be developed and tested in isolation" — is actually true, not just
source-shaped to look true.
