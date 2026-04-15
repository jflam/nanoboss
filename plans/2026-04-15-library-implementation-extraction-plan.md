# Library implementation extraction plan

## Purpose

This plan describes how to turn the current package surfaces into real libraries
with library-owned implementation files.

The goal is not to add more package names. The goal is to move ownership of
behavior into the package that claims to own that behavior, so the root app
becomes a small orchestrator over public library interfaces.

This plan assumes the ontology cleanup is largely done. The remaining work is
structural extraction, dependency cleanup, and app/runtime reduction.

## Problem statement

The repo now has good package names, but most packages are still thin facades
over root `src/` implementation.

That leaves three structural problems:

1. package boundaries are nominal rather than real
2. the app runtime still owns too much implementation detail
3. built-in procedures and generated procedures still depend on repo internals

As a result, the codebase looks library-shaped from the outside, but most
behavior is still centralized in root `src/core`, `src/procedure`,
`src/session`, and `src/agent`.

## Desired outcome

After this refactor:

- each package owns its implementation under `packages/<name>/src/`
- package `index.ts` files only re-export sibling files inside the same package
- no package imports implementation from root `src/`
- built-in procedures do not import from root `src/`
- generated procedures are not instructed to import from root `src/`
- the root app entrypoints mostly wire together public package APIs
- `@nanoboss/app-runtime` is the live orchestration layer, not a facade over
  `src/core/service.ts`
- adapters are thin and come last

## Non-goals

Do not do these in this refactor:

- do not redesign the public ontology again unless a concrete conflict appears
- do not add backward-compatibility aliases unless they are required for staged
  migration
- do not change durable data formats unless extraction forces it
- do not mix semantic rewrites with file moves when a pure extraction step is
  possible
- do not create extra packages unless there is a clear ownership gap that
  cannot be handled inside an existing package

## Structural rules

These rules define success.

### Package ownership rule

If behavior belongs to a library, its implementation must live inside that
library's source tree.

Bad:

- `packages/store/src/index.ts` re-exporting `../../../src/session/store.ts`

Good:

- `packages/store/src/session-store.ts`
- `packages/store/src/session-repository.ts`
- `packages/store/src/index.ts` re-exporting those sibling files

### Root `src/` rule

Root `src/` should shrink to one of these roles only:

- app entrypoints and top-level wiring
- temporary compatibility shims during the migration
- code that is explicitly part of the core app and not a reusable library

Root `src/` must not remain the default implementation home for package-owned
behavior.

### Dependency rule

Allowed package dependency direction:

1. `@nanoboss/contracts`
2. `@nanoboss/procedure-sdk`
3. `@nanoboss/store`
4. `@nanoboss/procedure-catalog`
5. `@nanoboss/agent-acp`
6. `@nanoboss/procedure-engine`
7. `@nanoboss/app-runtime`
8. adapters

Adapters may depend on `app-runtime`, but `app-runtime` must not depend on
adapter implementation details.

### Procedure rule

Built-in procedures and generated procedures should import only:

- `@nanoboss/procedure-sdk`
- package-specific public helpers
- local procedure-package helpers

They should not import `../src/...` or `../../src/...`.

### Index rule

Every `packages/*/src/index.ts` should only export files from its own package
tree.

No `../../../src/...` imports are allowed once the migration is complete.

## Target package responsibilities

### `@nanoboss/contracts`

Owns:

- canonical public types
- type constructors
- serialization-safe shared contracts

Must not own:

- prompt helpers
- filesystem code
- runtime orchestration
- ACP, HTTP, MCP, or TUI concerns

Suggested files:

- `packages/contracts/src/run.ts`
- `packages/contracts/src/session.ts`
- `packages/contracts/src/ref.ts`
- `packages/contracts/src/continuation.ts`
- `packages/contracts/src/agent.ts`
- `packages/contracts/src/prompt.ts`
- `packages/contracts/src/index.ts`

### `@nanoboss/procedure-sdk`

Owns:

- author-facing procedure interfaces
- procedure-side helper types
- stable helpers that procedures are expected to use

Must not own:

- app orchestration
- registry implementation
- durable store implementation

Suggested files:

- `packages/procedure-sdk/src/procedure.ts`
- `packages/procedure-sdk/src/state-api.ts`
- `packages/procedure-sdk/src/session-api.ts`
- `packages/procedure-sdk/src/ui-api.ts`
- `packages/procedure-sdk/src/json-type.ts`
- `packages/procedure-sdk/src/run-result-helpers.ts`
- `packages/procedure-sdk/src/prompt-input.ts`
- `packages/procedure-sdk/src/index.ts`

Notes:

- move `expectData(...)` and `expectDataRef(...)` here
- move any stable prompt-input helpers used by procedures here
- remove the need for procedure code to reach into app internals

### `@nanoboss/store`

Owns:

- durable session metadata
- durable run storage
- ref storage
- run graph traversal
- prompt image persistence if it is part of durable run state

Must not own:

- core config lookup
- frontend event vocabulary from the app
- app-specific type bridges

Suggested files:

- `packages/store/src/session-store.ts`
- `packages/store/src/session-repository.ts`
- `packages/store/src/run-record.ts`
- `packages/store/src/ref-store.ts`
- `packages/store/src/run-graph.ts`
- `packages/store/src/prompt-images.ts`
- `packages/store/src/paths.ts`
- `packages/store/src/index.ts`

Notes:

- if path resolution is currently hidden in core config, move the store-local
  path logic here or pass fully resolved paths from callers
- `cell` may remain internal inside the package, but not in the public API

### `@nanoboss/procedure-catalog`

Owns:

- procedure registration
- builtin loading
- disk discovery
- disk loading
- persistence of generated procedure source

Must not own:

- procedure implementations
- app orchestration
- runtime execution

Suggested files:

- `packages/procedure-catalog/src/registry.ts`
- `packages/procedure-catalog/src/disk-loader.ts`
- `packages/procedure-catalog/src/discovery.ts`
- `packages/procedure-catalog/src/persist.ts`
- `packages/procedure-catalog/src/builtins.ts`
- `packages/procedure-catalog/src/index.ts`

Notes:

- move builtin registration logic here
- move `src/procedure/create.ts` out of library internals and into
  `procedures/` as an actual builtin procedure

### `@nanoboss/agent-acp`

Owns:

- ACP connection management
- ACP session reuse
- prompt transport over ACP
- token snapshot collection
- typed parse/retry if that is part of agent-session behavior

Must not own:

- app policy
- prompt-building specific to nanoboss runtime orchestration
- global MCP registration policy

Suggested files:

- `packages/agent-acp/src/session.ts`
- `packages/agent-acp/src/runtime.ts`
- `packages/agent-acp/src/updates.ts`
- `packages/agent-acp/src/token-metrics.ts`
- `packages/agent-acp/src/transport.ts`
- `packages/agent-acp/src/index.ts`

Notes:

- if mounting nanoboss runtime capabilities is required, make that an injected
  capability hook, not hardwired app policy

### `@nanoboss/procedure-engine`

Owns:

- top-level procedure execution
- child procedure execution
- pause/resume
- cancellation boundaries
- runtime `ProcedureApi` implementation
- procedure dispatch jobs and recovery if they are execution concerns

Must not own:

- HTTP event shapes
- MCP tool parsing
- TUI behavior
- ACP implementation details beyond the abstract `AgentSession` contract

Suggested files:

- `packages/procedure-engine/src/top-level-runner.ts`
- `packages/procedure-engine/src/child-runner.ts`
- `packages/procedure-engine/src/context/context.ts`
- `packages/procedure-engine/src/context/agent-api.ts`
- `packages/procedure-engine/src/context/procedure-api.ts`
- `packages/procedure-engine/src/context/state-api.ts`
- `packages/procedure-engine/src/context/session-api.ts`
- `packages/procedure-engine/src/context/ui-api.ts`
- `packages/procedure-engine/src/dispatch/jobs.ts`
- `packages/procedure-engine/src/dispatch/recovery.ts`
- `packages/procedure-engine/src/cancellation.ts`
- `packages/procedure-engine/src/index.ts`

Notes:

- move `CommandContextImpl` and `context-*` ownership here
- move `runResultFromRunRecord(...)` here if it is execution-facing
- make the engine depend on contracts, sdk, and store only

### `@nanoboss/app-runtime`

Owns:

- live session lifecycle
- active run coordination
- default-agent-session policy
- continuation routing
- replay/recovery policy
- orchestration across store, engine, catalog, and agent session libraries
- runtime-neutral event emission

Must not own:

- HTTP/SSE envelopes
- MCP argument parsing
- ACP server transport
- TUI rendering
- library implementation details that belong in store, engine, catalog, or ACP
  session packages

Suggested files:

- `packages/app-runtime/src/service.ts`
- `packages/app-runtime/src/session-runtime.ts`
- `packages/app-runtime/src/active-run.ts`
- `packages/app-runtime/src/continuations.ts`
- `packages/app-runtime/src/default-agent-policy.ts`
- `packages/app-runtime/src/runtime-events.ts`
- `packages/app-runtime/src/replay.ts`
- `packages/app-runtime/src/index.ts`

Notes:

- split out transport-neutral runtime events here
- adapters should map those events to HTTP, MCP, ACP, or TUI-specific surfaces

### adapters

Own:

- serialization
- argument parsing
- transport mapping
- adapter-specific validation

Must not own:

- app policy
- store implementation
- procedure execution logic

Suggested shape:

- `packages/adapters-http/src/server.ts`
- `packages/adapters-http/src/client.ts`
- `packages/adapters-http/src/event-mapping.ts`
- `packages/adapters-mcp/src/server.ts`
- `packages/adapters-mcp/src/tool-schema.ts`
- `packages/adapters-acp-server/src/server.ts`
- `packages/adapters-tui/src/run.ts`
- `packages/adapters-tui/src/controller.ts`

## Built-in procedures and helper ownership

The current repo has a second ownership problem: built-in procedures use
app-internal helpers.

That should be normalized with this rule:

- if a helper is author-facing and stable, move it into
  `@nanoboss/procedure-sdk`
- if a helper is builtin-procedure-specific, move it into `procedures/lib/` or
  the relevant procedure package directory
- if a helper is app orchestration logic, keep it out of procedures entirely

Examples:

- `expectData(...)` and `expectDataRef(...)` should move to
  `@nanoboss/procedure-sdk`
- banner-formatting helpers used only by built-in commands should move under
  `procedures/lib/`
- simplify/autoresearch-specific helpers should live next to those procedure
  packages, not in root `src/core`

## Migration phases

## Phase 1: freeze the target boundaries

Before moving files, write the explicit ownership map for each current hotspot.

Required mapping list:

- `src/session/*` -> `@nanoboss/store`
- `src/procedure/registry.ts` and `src/procedure/disk-loader.ts` ->
  `@nanoboss/procedure-catalog`
- `src/procedure/runner.ts`, `src/procedure/dispatch-*`,
  `src/core/context*.ts` -> `@nanoboss/procedure-engine`
- `src/agent/acp-*`, runtime/session ACP helpers -> `@nanoboss/agent-acp`
- `src/core/service.ts` and runtime session coordination ->
  `@nanoboss/app-runtime`
- `src/http/*` -> adapters-http
- `src/mcp/*` -> adapters-mcp
- `src/tui/*` -> adapters-tui

Acceptance criteria:

- every package has a concrete file map
- no current root file is left in "shared by default" limbo

### Frozen ownership map

This is the extraction source-of-truth for the current root-owned hotspots.
Files not listed here stay root-app-owned for now; files listed here are not
"shared" and should move to the destination package/file noted below.

#### `@nanoboss/store`

- `src/session/store.ts` -> `packages/store/src/session-store.ts`
- `src/session/repository.ts` -> `packages/store/src/session-repository.ts`
- `src/session/store-refs.ts` -> `packages/store/src/ref-store.ts`
- `src/session/cleanup.ts` -> `packages/store/src/session-cleanup.ts`
- `src/session/picker-format.ts` -> `packages/store/src/session-picker-format.ts`

#### `@nanoboss/procedure-catalog`

- `src/procedure/registry.ts` -> `packages/procedure-catalog/src/registry.ts`
- `src/procedure/disk-loader.ts` -> `packages/procedure-catalog/src/disk-loader.ts`
- `src/procedure/names.ts` -> `packages/procedure-catalog/src/names.ts`
- `src/procedure/typia-bun-plugin.ts` -> `packages/procedure-catalog/src/typia-bun-plugin.ts`

#### `@nanoboss/procedure-engine`

- `src/procedure/runner.ts` -> `packages/procedure-engine/src/top-level-runner.ts`
- `src/procedure/dispatch-jobs.ts` -> `packages/procedure-engine/src/dispatch/jobs.ts`
- `src/procedure/dispatch-progress.ts` -> `packages/procedure-engine/src/dispatch/progress.ts`
- `src/procedure/dispatch-recovery.ts` -> `packages/procedure-engine/src/dispatch/recovery.ts`
- `src/core/context.ts` -> `packages/procedure-engine/src/context/context.ts`
- `src/core/context-agent.ts` -> `packages/procedure-engine/src/context/agent-api.ts`
- `src/core/context-procedures.ts` -> `packages/procedure-engine/src/context/procedure-api.ts`
- `src/core/context-session.ts` -> `packages/procedure-engine/src/context/session-api.ts`
- `src/core/context-state.ts` -> `packages/procedure-engine/src/context/state-api.ts`
- `src/core/context-shared.ts` -> `packages/procedure-engine/src/context/shared.ts`

#### `@nanoboss/agent-acp`

- `src/agent/acp-runtime.ts` -> `packages/agent-acp/src/runtime.ts`
- `src/agent/acp-session.ts` -> `packages/agent-acp/src/session.ts`
- `src/agent/acp-updates.ts` -> `packages/agent-acp/src/updates.ts`
- `src/agent/token-metrics.ts` -> `packages/agent-acp/src/token-metrics.ts`
- `src/agent/token-usage.ts` -> `packages/agent-acp/src/token-usage.ts`
- `src/agent/call-agent.ts` -> `packages/agent-acp/src/transport.ts`
- `src/agent/runtime-capability.ts` -> `packages/agent-acp/src/runtime-capability.ts`

#### `@nanoboss/app-runtime`

- `src/core/service.ts` -> `packages/app-runtime/src/service.ts`
- `src/runtime/service.ts` -> `packages/app-runtime/src/runtime-service.ts`
- `src/runtime/api.ts` -> `packages/app-runtime/src/runtime-api.ts`
- `src/core/ui-emitter.ts` -> `packages/app-runtime/src/runtime-events.ts`

#### `@nanoboss/adapters-http`

- `src/http/server.ts` -> `packages/adapters-http/src/server.ts`
- `src/http/client.ts` -> `packages/adapters-http/src/client.ts`
- `src/http/private-server.ts` -> `packages/adapters-http/src/private-server.ts`
- `src/http/server-supervisor.ts` -> `packages/adapters-http/src/server-supervisor.ts`
- `src/http/frontend-events.ts` -> `packages/adapters-http/src/event-mapping.ts`

#### `@nanoboss/adapters-mcp`

- `src/mcp/server.ts` -> `packages/adapters-mcp/src/server.ts`
- `src/mcp/registration.ts` -> `packages/adapters-mcp/src/registration.ts`
- `src/mcp/jsonrpc.ts` -> `packages/adapters-mcp/src/jsonrpc.ts`
- `src/mcp/stdio-jsonrpc.ts` -> `packages/adapters-mcp/src/stdio-jsonrpc.ts`

#### `@nanoboss/adapters-tui`

- `src/tui/app.ts` -> `packages/adapters-tui/src/app.ts`
- `src/tui/commands.ts` -> `packages/adapters-tui/src/commands.ts`
- `src/tui/composer.ts` -> `packages/adapters-tui/src/composer.ts`
- `src/tui/controller.ts` -> `packages/adapters-tui/src/controller.ts`
- `src/tui/format.ts` -> `packages/adapters-tui/src/format.ts`
- `src/tui/pi-tui.ts` -> `packages/adapters-tui/src/pi-tui.ts`
- `src/tui/reducer.ts` -> `packages/adapters-tui/src/reducer.ts`
- `src/tui/run.ts` -> `packages/adapters-tui/src/run.ts`
- `src/tui/state.ts` -> `packages/adapters-tui/src/state.ts`
- `src/tui/theme.ts` -> `packages/adapters-tui/src/theme.ts`
- `src/tui/views.ts` -> `packages/adapters-tui/src/views.ts`
- `src/tui/clipboard/**/*` -> `packages/adapters-tui/src/clipboard/**/*`
- `src/tui/components/**/*` -> `packages/adapters-tui/src/components/**/*`
- `src/tui/overlays/**/*` -> `packages/adapters-tui/src/overlays/**/*`

#### Adjacent non-library ownership decisions frozen now

- `src/core/acp-server.ts` -> `packages/adapters-acp-server/src/server.ts`
- `src/procedure/create.ts` -> `procedures/create.ts`

## Phase 2: make package trees real before reducing behavior

Create the internal file trees under `packages/*/src/` first.

Implementation posture:

- start by copying structure and moving logic with minimal semantic change
- keep root compatibility shims temporarily if needed
- do not rewrite behavior and ownership in the same step when extraction alone
  is possible

Acceptance criteria:

- each package has package-owned implementation files
- each package `index.ts` exports only sibling package files
- temporary root shims are one-line forwards into the package, not the reverse

## Phase 3: extract `@nanoboss/store`

Move all session/run/ref durability code into `packages/store/src/`.

Key work:

- split the current large store file into repository, run graph, refs, prompt
  images, and path helpers
- remove imports from root `src/core/*`
- eliminate app-specific type bridge logic from the store package

Acceptance criteria:

- no store implementation remains in `src/session/`
- root callers import `@nanoboss/store`
- store tests run through package-owned files

## Phase 4: extract `@nanoboss/procedure-catalog`

Move registry and disk loader implementation into the package.

Key work:

- move builtin registration into package-owned files
- move generated procedure persistence into package-owned files
- move `/create` implementation out of `src/procedure/create.ts` and into
  `procedures/`

Acceptance criteria:

- no catalog implementation remains in `src/procedure/registry.ts` or
  `src/procedure/disk-loader.ts`
- the package owns builtin registration
- generated procedure persistence no longer depends on root `src/` internals

## Phase 5: extract `@nanoboss/agent-acp`

Move ACP implementation into the package.

Key work:

- relocate ACP session, runtime, updates, and token files
- isolate app-specific runtime capability injection behind an interface
- remove direct dependence on root app helpers

Acceptance criteria:

- no ACP implementation remains in `src/agent/` except temporary shims
- `agent-acp` can be tested without importing root app modules

## Phase 6: extract `@nanoboss/procedure-engine`

This is the most important structural step.

Key work:

- move `CommandContextImpl` and `context-*` files into package-owned engine
  context files
- move top-level and nested procedure execution into the package
- move dispatch jobs and recovery into engine-owned files
- move procedure-result mapping helpers into either engine or sdk based on who
  owns the public surface
- define the engine's internal collaborator split so the engine itself is not
  one new giant file

Acceptance criteria:

- no primary execution logic remains in `src/procedure/` or
  `src/core/context*.ts`
- app runtime calls engine public APIs rather than internal context classes
- engine package tests use fake registry, fake store, fake agent session, and
  do not import root app internals

## Phase 7: extract and reduce `@nanoboss/app-runtime`

Only after store, catalog, ACP, and engine are real should app-runtime be
reduced.

Key work:

- move live session coordination from `src/core/service.ts` into package-owned
  files
- split runtime-neutral events from HTTP-specific frontend mapping
- make the service a composition root over public library interfaces

Suggested internal split:

- session lifecycle
- active run management
- default session policy
- continuation routing
- replay/recovery policy
- runtime event emission

Acceptance criteria:

- `NanobossService` lives in `packages/app-runtime/src/`
- it orchestrates libraries instead of implementing their internals
- transport-specific mapping is gone from app-runtime

## Phase 8: thin the adapters

Once app-runtime is real, reduce the adapters to mapping layers.

Key work:

- move HTTP event shaping to adapters-http
- move MCP tool argument parsing and tool mapping to adapters-mcp
- move ACP server wrapping to adapters-acp-server
- keep TUI in adapters-tui

Acceptance criteria:

- adapters depend on app-runtime and library public APIs only
- no adapter owns business logic

## Phase 9: clean built-in procedures and generated procedures

After sdk and engine seams are real, remove root `src/` imports from
procedures.

Key work:

- move stable procedure helpers into `@nanoboss/procedure-sdk`
- move builtin-only helpers into `procedures/lib/` or procedure package-local
  helpers
- update `/create` guidance so generated procedures never recommend `src/`
  imports

Acceptance criteria:

- `rg '../src/' procedures` returns nothing
- `rg '../../src/' procedures` returns nothing
- `src/procedure/create.ts` no longer instructs agents to import from root
  internals

## Phase 10: delete the reverse facades

At the end, remove temporary root shims and compatibility modules.

Delete or reduce:

- root `src/session/*`
- root `src/procedure/*` that only existed for package ownership before
  extraction
- root `src/agent/*` that migrated into `agent-acp`
- root `src/core/types.ts` and `src/core/contracts.ts` compatibility surfaces
  if no longer needed

Acceptance criteria:

- package implementations are canonical
- root `src/` is materially smaller
- there is no reverse dependency from packages back into root implementation
  files

## Test strategy

Each package should have tests that prove the package is real, not just named.

### Contracts

- compile and shape tests

### Procedure SDK

- consumer-style compile tests
- tests for `jsonType(...)`
- tests for result helpers such as `expectData(...)`

### Store

- run graph tests
- ref tests
- session metadata tests
- prompt image persistence tests if that remains store-owned

### Procedure catalog

- fixture-based registry tests
- disk discovery tests
- procedure loading tests
- generated procedure persistence tests

### Agent ACP

- mocked protocol tests
- session reuse tests
- token snapshot tests

### Procedure engine

- fake-based execution tests
- nested procedure tests
- pause/resume tests
- cancellation tests
- dispatch recovery tests

### App runtime

- session lifecycle tests
- continuation routing tests
- replay/recovery tests
- default-agent-session policy tests
- runtime-event emission tests

### Adapters

- thin mapping tests only

### Structural enforcement tests

Add explicit structural checks:

- package source files must not import root `src/`
- procedures must not import root `src/`
- package `index.ts` files must only re-export local package files

A simple grep-based or AST-based test is acceptable.

## Guidance for future agents

These are the repo rules after the refactor.

### What is the core app

The core app is `@nanoboss/app-runtime` plus the top-level entrypoints that
wire it to transports.

Its job is:

- session orchestration
- policy
- continuation routing
- composing libraries

Its job is not:

- implementing storage
- implementing the procedure runtime context
- implementing ACP transport
- implementing HTTP or MCP adapters

### What are the libraries

Libraries are packages with owned implementation and stable public interfaces.

A library should gain code when:

- the code belongs to that package's domain
- the code can be tested at that package boundary
- the code should be usable without reaching into another package's internals

### Where new code should go

Add code to `@nanoboss/app-runtime` only if it is truly orchestration or
policy.

Add code to a library if it belongs to that domain and can be expressed behind
that library's public surface.

Add code to an adapter only if it is transport mapping or serialization.

Add code to `procedures/` only if it is builtin procedure behavior or
builtin-only procedure helpers.

Do not add new implementation to root `src/` unless it is a temporary migration
shim or a true top-level entrypoint concern.

## Definition of done

This plan is complete when all of the following are true:

- package implementation lives inside `packages/*/src/`
- package `index.ts` files do not reach into root `src/`
- built-in procedures do not import root `src/`
- generated procedures are not taught to import root `src/`
- `@nanoboss/app-runtime` is a real orchestration library
- adapters are thin
- root `src/` is no longer the hidden implementation home for the package graph
- tests exist for each package at its own boundary
- structural guardrails exist so the repo cannot regress back into facade
  packages

## Recommended execution order

1. freeze the ownership map
2. make package source trees real
3. extract store
4. extract procedure catalog
5. extract agent-acp
6. extract procedure engine
7. extract app-runtime
8. thin adapters
9. clean procedures and `/create`
10. delete reverse facades and add structural guards
