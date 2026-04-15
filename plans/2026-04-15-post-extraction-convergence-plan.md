# Post-extraction app convergence plan

## Purpose

This plan continues from
`plans/2026-04-15-library-implementation-extraction-plan.md`.

The extraction work gave the repo package boundaries. The remaining work is to
finish the inversion:

- package code must stop reaching back into root `src/`
- the root app must be expressed in terms of public package APIs
- duplicate helpers in `src/` and `packages/` must collapse to one owner
- `src/core` must stop being the fallback implementation home

The logical end state is not "mostly library-shaped". The logical end state is:
real packages own behavior, the root app is a small wiring layer, and there is
no ambiguous shared implementation island left in `src/core`.

## Current state

Current snapshot on 2026-04-15:

- `src/` contains 49 TypeScript files and 4,705 lines
- `src/core/` alone contains 34 files and 3,805 lines
- there are 7 obvious one-line compatibility shims:
  - `src/agent/token-metrics.ts`
  - `src/core/service.ts`
  - `src/http/client.ts`
  - `src/http/server.ts`
  - `src/mcp/jsonrpc.ts`
  - `src/session/repository.ts`
  - `src/tui/controller.ts`
- there are 2 near-shims that should not survive as "core":
  - `src/core/defaults.ts`
  - `src/core/runtime-mode.ts`
- `packages/app-runtime/src/` still has 25 direct imports back into
  `src/core/*`

The highest-value remaining problem is not the shim count. It is that
`@nanoboss/app-runtime` still depends on root `src/core` for prompt handling,
memory cards, timing traces, error formatting, config resolution, runtime
events, and shared type barrels. That means the runtime package is still not a
real leaf in the dependency graph.

There is also clear duplicate code already present across root and package
trees:

- prompt helpers: `src/core/prompt.ts`, `packages/procedure-sdk/src/prompt-input.ts`,
  `packages/procedure-engine/src/prompt.ts`, `packages/agent-acp/src/prompt.ts`
- run-result/data-shape helpers: `src/core/run-result.ts`,
  `src/core/data-shape.ts`, `packages/procedure-engine/src/run-result.ts`,
  `packages/procedure-engine/src/data-shape.ts`
- error/cancellation/timing helpers: root `src/core/*` copies and
  `packages/procedure-engine/src/*` copies
- type barrels: `src/core/types.ts` and `src/core/contracts.ts`
- model catalog: `src/agent/model-catalog.ts`,
  `packages/adapters-tui/src/model-catalog.ts`,
  `procedures/lib/model-catalog.ts`
- repo helper utilities: `src/util/repo-artifacts.ts`,
  `src/core/repo-fingerprint.ts`, `procedures/lib/*`
- build-info helpers: root and multiple adapter-local copies

## Desired end state

When this plan is complete:

- no package imports any implementation from root `src/`
- `src/core/` no longer exists
- root `src/` contains only app entrypoints, command parsing, and thin wiring
- root `src/` is reduced to a small footprint with a target budget of:
  - fewer than 12 TypeScript files
  - fewer than 1,000 lines
- all one-line shims are removed
- duplicated helpers have one canonical owner
- top-level app code imports package entrypoints, not `packages/*/src/*`
- package boundaries are enforced by tests or a CI architecture check

## Structural decisions

These decisions keep the remaining work coherent.

### Rule 1: kill reverse imports first

The first blocker is `packages/app-runtime -> src/core`.

Until that is gone, the runtime package is still a facade over root code. Phase
1 therefore removes all `../../../src/core/*` imports from
`packages/app-runtime/src/` before broader cleanup.

### Rule 2: delete `src/core`, do not preserve it as a smaller junk drawer

Some code remaining in `src/core` is still legitimate app code. That is not a
reason to keep the directory.

If code is root-app-owned, move it into a clearer root namespace such as:

- `src/commands/`
- `src/options/`
- `src/app-support/`
- `src/dev/`

The steady state should be "small root app", not "smaller core directory".

### Rule 3: prefer an existing package owner before creating a new package

Use an existing package if there is a credible semantic owner.

Examples:

- agent config/model selection helpers -> `@nanoboss/agent-acp`
- public prompt-input helpers -> `@nanoboss/procedure-sdk`
- execution/runtime helpers -> `@nanoboss/procedure-engine`
- durable settings and stored-value conversion -> `@nanoboss/store`
- builtin-procedure-only helpers -> `procedures/lib/`

Only create a new internal support package if a helper is genuinely shared by
multiple unrelated packages and has no good existing owner.

### Rule 4: delete root type barrels rather than maintaining aliases

`src/core/types.ts` and `src/core/contracts.ts` should not survive as
cross-package aggregation points.

Callers should import directly from the package that owns the symbol.

## Frozen disposition map

This is the source-of-truth for the remaining root code.

### Delete after callsites move

- `src/agent/token-metrics.ts`
- `src/core/service.ts`
- `src/http/client.ts`
- `src/http/server.ts`
- `src/mcp/jsonrpc.ts`
- `src/session/repository.ts`
- `src/tui/controller.ts`

### Converge into `@nanoboss/app-runtime`

These are runtime orchestration concerns, not root-app concerns:

- `src/core/agent-runtime-instructions.ts`
- `src/core/memory-cards.ts`
- `src/core/run-events.ts`
- `src/core/runtime-mode.ts`
- the runtime-only prompt augmentation pieces currently living in
  `src/core/prompt.ts`

Notes:

- `src/core/tool-call-preview.ts` and
  `src/core/tool-payload-normalizer.ts` should either move into
  `@nanoboss/app-runtime` or an adapter-facing owner decided in Phase 2, but
  they must stop being root-owned because `app-runtime` currently imports them
  directly.

### Converge into `@nanoboss/procedure-engine`

These already have package-local twins or are clearly execution helpers:

- `src/core/cancellation.ts`
- `src/core/error-format.ts`
- `src/core/timing-trace.ts`
- `src/core/logger.ts`
- `src/core/self-command.ts`
- `src/core/data-shape.ts`
- `src/core/run-result.ts`

Notes:

- `expectData(...)` and `expectDataRef(...)` are already in
  `@nanoboss/procedure-sdk`; root copies should disappear.
- switch callers to the package versions before deleting the root files.

### Converge into `@nanoboss/procedure-sdk`

These are public or broadly reusable helpers:

- the public prompt-input helpers in `src/core/prompt.ts`
  - `createTextPromptInput(...)`
  - `normalizePromptInput(...)`
  - `parsePromptInputPayload(...)`
  - `promptInputDisplayText(...)`
  - `promptInputAttachmentSummaries(...)`
  - `hasPromptInputImages(...)`
  - `hasPromptInputContent(...)`
  - `buildImageTokenLabel(...)`
- `src/procedure/tagged-json-line-stream.ts`
- `src/util/text.ts`
- `src/core/runtime-banner.ts` should be replaced by the existing
  `packages/procedure-sdk/src/agent-banner.ts`

### Converge into `@nanoboss/agent-acp`

These describe downstream agent behavior rather than root app behavior:

- the ACP-specific prompt conversion pieces from `src/core/prompt.ts`
  - `promptInputToAcpBlocks(...)`
  - `summarizePromptInputForAcpLog(...)`
  - `promptInputFromAcpBlocks(...)`
- `src/core/config.ts` should be split so transport-default logic lands here
- `src/agent/model-catalog.ts`

Additional convergence:

- replace the duplicate model-catalog copies in
  `packages/adapters-tui/src/model-catalog.ts` and `procedures/lib/model-catalog.ts`
  with a single owner here

### Converge into `@nanoboss/store`

These are durable storage or stored-value translation concerns:

- `src/core/settings.ts`
- the strict validation half of `src/core/downstream-agent-selection.ts`
- the stored-value conversion helpers currently exposed through
  `src/core/types.ts`

Notes:

- `packages/store/src/stored-values.ts` already has
  `publicKernelValueFromStored(...)`
- `packages/store/src/agent-selection.ts` already owns the permissive parser
- finish the move here instead of keeping root wrappers

### Converge into `procedures/lib/` or a procedure-specific helper module

These are builtin-procedure helpers, not general app runtime:

- `src/util/repo-artifacts.ts`
- `src/core/repo-fingerprint.ts`
- `src/util/compact-test-cache.ts`

Notes:

- `procedures/lib/repo-artifacts.ts` and `procedures/lib/repo-fingerprint.ts`
  already exist
- `src/util/compact-test-cache.ts` should likely merge into
  `procedures/nanoboss/test-cache-lib.ts` rather than remain in root

### Keep root-owned, but move out of `src/core`

These are app or developer command concerns, not reusable libraries:

- `src/core/doctor.ts`
- `src/core/build-size-report.ts`
- `src/core/build-freshness.ts`
- `src/core/defaults.ts`
- `src/options/frontend-connection.ts`
- `src/options/resume.ts`

These should end up in command-oriented or app-support-oriented root folders,
not in `src/core`.

### Decide in Phase 2 whether to extract a tiny internal support package

These helpers are shared enough to deserve a single owner, but they do not
obviously belong to contracts/store/engine/adapters today:

- `src/core/build-info.ts`
- `src/core/install-path.ts`
- `src/core/procedure-paths.ts`
- `src/core/workspace-identity.ts`

Decision rule:

- if a credible existing package owner emerges, move there
- otherwise create one small internal package such as
  `@nanoboss/app-support` and move these there once, instead of preserving
  multiple copies across adapters and root app code

## Migration phases

### Phase 1: make `@nanoboss/app-runtime` independent of root `src/core`

This is the critical path.

Work:

- replace `packages/app-runtime/src/runtime-service.ts` usage of
  `src/core/types.ts` with `@nanoboss/store` exports such as
  `publicKernelValueFromStored(...)`
- replace runtime banner usage with the package-owned banner helper
- move runtime-owned helpers out of `src/core` into `packages/app-runtime/src/`
- switch `packages/app-runtime/src/service.ts` to package-owned
  `cancellation`, `error-format`, `timing-trace`, and prompt helpers
- stop importing `src/core/contracts.ts` and `src/core/types.ts`; import public
  package types directly

Acceptance criteria:

- `rg "../../../src/core/" packages/app-runtime/src` returns no matches
- `@nanoboss/app-runtime` builds using package dependencies only
- runtime behavior stays unchanged except for import ownership

### Phase 2: collapse duplicated helpers to one owner

Once `app-runtime` is clean, remove the remaining duplication clusters.

Work:

- delete root duplicates that already have package twins
- converge prompt helper responsibilities explicitly:
  - public prompt input helpers -> `@nanoboss/procedure-sdk`
  - ACP conversion/log helpers -> `@nanoboss/agent-acp`
  - runtime prompt augmentation -> `@nanoboss/app-runtime`
- converge model catalog into one owner and repoint TUI and builtin procedures
- converge repo helper utilities into `procedures/lib/` where appropriate
- decide the owner for build-info/install-path/workspace-identity/procedure-paths
  and remove copied variants

Acceptance criteria:

- no helper exists in both root `src/` and a package tree unless there is a
  written reason and an explicit migration step still open
- the model catalog exists in one place
- root type barrels are gone

### Phase 3: delete `src/core` by moving root-app-only code to explicit root folders

Do not leave a reduced `src/core`.

Work:

- move command code into `src/commands/`
- move option parsing into `src/options/` or `src/commands/options/`
- move root-only support helpers into `src/app-support/` or `src/dev/`
- update imports so root code no longer references `src/core/*`

Suggested destination shape:

- `src/commands/doctor.ts`
- `src/commands/http-options.ts`
- `src/options/frontend-connection.ts`
- `src/options/resume.ts`
- `src/dev/build-size-report.ts`
- `src/app-support/build-freshness.ts`

Acceptance criteria:

- `src/core/` no longer exists
- every remaining root file is obviously app-entrypoint-owned or dev-command-owned

### Phase 4: make top-level entrypoints use package public APIs only

The root app should depend on package entrypoints, not package internals.

Work:

- export any missing public entrypoints from package `index.ts` files
- remove imports like `./packages/app-runtime/src/runtime-service.ts` from
  `nanoboss.ts`
- ensure root app code imports `@nanoboss/<package>` entrypoints instead of
  `packages/<name>/src/*`
- keep root responsibilities narrow:
  - subcommand dispatch
  - CLI-only option parsing
  - command selection across adapters

Acceptance criteria:

- `rg "packages/.*/src/" nanoboss.ts src` returns no matches
- root entrypoints can be read as wiring code rather than implementation code

### Phase 5: remove shims and dead root code

Only do this after the import graph is clean.

Work:

- delete all one-line compatibility shims
- remove any no-longer-used root helper that survived earlier phases
- update tests and imports to package paths

Acceptance criteria:

- `find src -type f -name '*.ts' -exec wc -l {} + | grep ' 1 '` shows no
  compatibility re-export files
- no code outside temporary migration branches imports the deleted shim paths

### Phase 6: lock the architecture with automated checks

Without enforcement, `src/core` will slowly reappear.

Work:

- add a repository check that forbids `packages/** -> src/**` imports
- add a check that forbids root entrypoints from importing `packages/*/src/*`
- add a check that flags duplicate helper clusters that were explicitly
  collapsed in this plan
- add package-focused tests so libraries can be tested independently of the
  root app

Suggested checks:

- `rg "from ['\\\"](\\.\\./)+src/" packages`
- `rg "packages/.*/src/" nanoboss.ts src`
- a small script that enforces the allowed dependency direction

Acceptance criteria:

- CI fails on boundary regressions
- each package can be exercised through its public surface without depending on
  root `src/`

## Final steady state

This work is done when the repo looks like this:

- `packages/` contains the implementation for reusable behavior
- `procedures/` contains builtin-procedure code and builtin-only helpers
- root code is a thin shell around package APIs
- there is no `src/core`
- there are no root compatibility shims
- there is no ambiguity about where a new behavior belongs

That is the point where package isolation becomes real: changes stay local,
package tests become credible, and future refactors stop re-centralizing in the
root app.
