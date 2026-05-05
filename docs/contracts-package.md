# `@nanoboss/contracts`

`@nanoboss/contracts` is the lowest-level shared type package. It defines the
small durable shapes that multiple Nanoboss packages exchange: run references,
value references, session metadata, prompt input, continuation state, stored run
records, token usage, and downstream agent session contracts.

It owns:

- durable run, ref, and session identity shapes
- prompt input and image attachment shapes
- continuation and pending-continuation shapes
- stored run record and run summary shapes
- downstream agent selection/config/session types
- token snapshot and normalized token usage shapes
- tiny constructors for canonical `RunRef`, `Ref`, and `SessionRef` values

It does not own:

- runtime orchestration
- persistence implementation
- procedure authoring helpers
- procedure execution behavior
- adapter protocol envelopes
- frontend rendering state
- helper formatting, data-shape inference, or prompt normalization

Those boundaries matter:

- `@nanoboss/procedure-sdk` re-exports stable author-facing contract types and
  owns helper behavior around them.
- `@nanoboss/store` persists values shaped by this package.
- `@nanoboss/app-runtime` projects stored/runtime state into adapter-neutral
  events.
- adapters may use these types, but should own their protocol-specific request
  and response envelopes separately.

## Public Interface

The package entrypoint is `packages/contracts/src/index.ts`.

The runtime value surface has only three helpers:

- `createRunRef(sessionId, runId)`
- `createRef(run, path)`
- `createSessionRef(sessionId)`

Everything else is a TypeScript type or interface.

## Contract Families

### Identity

- `RunRef`
- `Ref`
- `SessionRef`
- `SessionDescriptor`

These are stable identities used across store, runtime, MCP, HTTP, TUI, and
procedure code. Keep them structural and small.

### Kernel Values

- `KernelScalar`
- `JsonValue`
- `KernelValue`

`KernelValue` is intentionally broad because stored procedure data can include
plain JSON, run references, refs, arrays, and objects. Runtime validation and
shape inference belong outside this package.

### Prompt Input

- `PromptInput`
- `PromptPart`
- `PromptImagePart`
- `PromptImageSummary`

This package owns the durable prompt shape. Parsing, normalization, display
text, and image-token labels belong to `@nanoboss/procedure-sdk`.

### Continuations

- `Continuation`
- `ContinuationForm`
- `PendingContinuation`

Continuations describe paused procedure state. The form payload remains an open
JSON value so procedure/runtime packages can evolve form renderers without
turning `contracts` into a UI package.

### Stored Runs

- `RunKind`
- `RunRecord`
- `RunSummary`
- `RunFilterOptions`
- `RunAncestorsOptions`
- `RunDescendantsOptions`
- `RunListOptions`
- `RefStat`

These are durable store/runtime traversal contracts. Store owns serialization;
runtime owns query behavior and projection; this package only owns the shared
shape.

### Downstream Agents and Tokens

- `DownstreamAgentProvider`
- `DownstreamAgentSelection`
- `DownstreamAgentConfig`
- `AgentSession`
- `AgentSessionPromptOptions`
- `AgentSessionPromptResult`
- `AgentTokenSnapshot`
- `AgentTokenUsage`

These types let `agent-acp`, `procedure-engine`, `app-runtime`, and adapters
share provider/session/token shapes without depending on each other.

## Build Artifacts

This package keeps checked-in `src/index.js` and `src/index.d.ts` files beside
`src/index.ts`. They are part of the current package contract for runtime and
type consumers. Do not edit only one representation unless the package build
workflow also updates the others.

## Simplification Rules

- Keep this package dependency-free.
- Add shapes only when at least two packages need the same durable contract.
- Do not add functions unless they are tiny constructors for canonical shapes.
- Do not add validation, formatting, parsing, or persistence behavior here.
- Prefer `@nanoboss/procedure-sdk` for author-facing helpers and
  `@nanoboss/app-support` for low-level filesystem/process helpers.

## Current Review Metrics

Measured during the 2026-05 contracts review:

- source files: 3 checked-in entrypoint representations
- `src/index.ts` lines: 254
- `src/index.d.ts` lines: 206
- `src/index.js` lines: 9
- workspace package dependencies: 0
- runtime value exports: 3
- public wildcard exports: 0
- code simplification applied: none; the package is already a minimal
  dependency-free contract owner

The useful outcome of this pass is the boundary baseline: future changes should
be suspicious if they add behavior, dependencies, or broad helper functions to
this package.

## Good Future Targets

- Remove stale test-only expectations around fields that no longer exist on
  continuation shapes if they stop documenting compatibility.
- Revisit whether checked-in `.js` and `.d.ts` artifacts are still required if
  package build/publish rules change.
- Keep new adapter protocol payloads out of this package unless they become
  durable cross-package state.
