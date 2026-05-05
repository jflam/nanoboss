# `@nanoboss/app-runtime`

`@nanoboss/app-runtime` is the application orchestration package. It binds
procedure execution, session state, event logs, memory cards, runtime tools, and
frontend-facing event projection into one package that adapters can call without
knowing procedure-engine or store internals.

It owns:

- foreground Nanoboss session orchestration through `NanobossService`
- runtime API methods used by MCP and other tool-style clients
- conversion from ACP/procedure updates into runtime event envelopes
- active session state, event logs, command lists, and replayable event history
- procedure memory-card collection/rendering for default-agent context
- frontend-safe tool-call and turn-display summaries

It does not own:

- procedure authoring contracts
- procedure discovery rules
- procedure execution internals once a procedure call begins
- durable storage layout
- ACP transport details
- concrete HTTP, MCP, ACP-server, or TUI protocol handling
- TUI rendering policy or extension registries

Those boundaries matter:

- `@nanoboss/procedure-sdk` owns author-facing procedure and result contracts.
- `@nanoboss/procedure-catalog` owns procedure discovery and metadata
  projection.
- `@nanoboss/procedure-engine` owns execution semantics and async dispatch jobs.
- `@nanoboss/store` owns persisted sessions, runs, refs, and workspace session
  metadata.
- adapter packages own protocol translation and presentation.

## Public Interface

The package entrypoint is
`packages/app-runtime/src/index.ts`. Its public surface is intentionally
explicit; avoid wildcard exports from the barrel because they can expose
implementation classes from downstream packages.

The surface has four groups.

### 1. Foreground session runtime

- `NanobossService`

`NanobossService` is the live session orchestrator used by interactive and
server adapters. It keeps session state, default-agent policy, event logs,
command lists, continuation state, and foreground procedure execution together.

Adapters should treat it as the high-level live-session object. They should not
construct procedure-engine contexts or `SessionStore` instances for foreground
turns.

### 2. Tool/runtime service

- `createNanobossRuntimeService(...)`
- `createCurrentSessionBackedNanobossRuntimeService(...)`
- `NanobossRuntimeService`
- `RuntimeService`
- runtime API result and argument types

`NanobossRuntimeService` is the narrower tool-facing API used by MCP-style
clients. It exposes run/ref inspection, schema inspection, procedure listing,
and async procedure dispatch start/status/wait.

The top-level `nanoboss mcp` command uses
`createCurrentSessionBackedNanobossRuntimeService(...)`, which allows the server
to bind to the current workspace session without the caller passing a session id
manually.

### 3. Runtime events and replay

- `RuntimeEvent`
- `RuntimeEventEnvelope`
- event envelope type aliases
- event type guards
- `mapSessionUpdateToRuntimeEvents(...)`
- `mapProcedureUiEventToRuntimeEvent(...)`
- `toRuntimeCommands(...)`
- `toPersistedRuntimeEvent(...)`

Runtime events are the adapter-neutral stream emitted from live session work.
HTTP re-exports these as frontend events, while the TUI consumes the same event
shape through its own adapter code. The runtime event layer is allowed to know
about ACP update shapes and procedure UI event shapes, but it should emit plain
runtime envelopes that adapters can translate without calling lower-level
package internals.

### 4. Prompt, memory, and tool presentation internals

- `buildTurnDisplay(...)`

These helpers are runtime presentation policy, not procedure authoring API. The
prompt and memory-card helpers are source-level implementation seams used by
default-agent policy and service memory synchronization; `buildTurnDisplay(...)`
remains public because downstream adapters share its turn projection shape.
They should stay small and deterministic. Tool-call preview summarizers and
runtime-mode gates are source-level implementation seams, not package
entrypoint APIs. Generic data helpers belong in `@nanoboss/procedure-sdk` or
`@nanoboss/app-support`, not here.

## Package Structure

- `src/service.ts`
  Live foreground session orchestration.
- `src/runtime-service.ts`
  Tool-style runtime API implementation.
- `src/runtime-api.ts`
  Interface and result types for the runtime API.
- `src/runtime-events.ts`
  Adapter-neutral event projection and event-log storage.
- `src/runtime-tool-events.ts`
  Tool-call runtime event projection, preview shaping, cancellation status, and
  token usage extraction.
- `src/runtime-commands.ts`
  Command metadata projection and session command-update publication.
- `src/prompt-run-lifecycle.ts`
  Prompt run startup state, heartbeat, replay capture, and composite emitter
  wiring.
- `src/composite-session-update-emitter.ts`
  Session update fanout into runtime events, token snapshots, and delegate
  emitters.
- `src/session-runtime.ts`
  Live session state and persisted descriptor helpers.
- `src/continuations.ts`
  Continuation command conversion and pending continuation state publication.
- `src/continuation-cancel.ts`
  Paused continuation cancel-hook execution, error panel publication, and
  terminal cancellation persistence.
- `src/default-agent-policy.ts`
  Default downstream-agent prewarm and prompt preparation policy.
- `src/procedure-runtime-bindings.ts`
  Foreground procedure runtime bindings and default-agent selection updates.
- `src/memory-cards.ts`
  Procedure memory-card extraction and prompt rendering.
- `src/procedure-dispatch-manager.ts`
  Async procedure dispatch cancellation helpers.
- `src/tool-call-preview.ts`
  Adapter-neutral tool-call summary blocks.
- `src/tool-preview-text.ts`
  Text normalization and bounded preview-line helpers for tool summaries.
- `src/turn-display.ts`
  Turn-display reconstruction from persisted runtime events.
- `src/replay.ts`
  Replay capture and restoration helpers.
- `src/active-run.ts`
  Active run heartbeat state.
- `src/run-events.ts`
  Run terminal-event builders.
- `src/run-publication.ts`
  Terminal run publication, display fallback emission, and stored memory-card
  events.
- `src/runtime-prompt.ts`
  Prompt-input text prepending.
- `src/runtime-mode.ts`
  Disk-command loading gate.

## Call Paths

Foreground interactive flow:

1. `nanoboss.ts` routes `nanoboss cli` or `nanoboss resume`.
2. The TUI adapter creates or resumes a live `NanobossService`.
3. `NanobossService` loads procedures, manages session state, and calls
   `executeProcedure(...)` from `@nanoboss/procedure-engine`.
4. Procedure/ACP updates are projected into runtime events and adapter views.

MCP/runtime tool flow:

1. `nanoboss.ts` routes `nanoboss mcp`.
2. The command creates `createCurrentSessionBackedNanobossRuntimeService()`.
3. The MCP adapter calls the `RuntimeService` interface.
4. Runtime-service methods compose store, catalog, procedure-engine dispatch,
   and SDK data-shape helpers.

HTTP/frontend flow:

1. HTTP owns transport and SSE framing.
2. It imports runtime event types and guards through `@nanoboss/app-runtime`.
3. It aliases those runtime events as frontend events without reimplementing the
   projection logic.

## Simplification Rules

- Keep `src/index.ts` explicit. A new public export should have a known adapter,
  test, or top-level command consumer.
- Do not re-export concrete implementation classes from dependency packages.
  For example, `UiApiImpl` belongs to `@nanoboss/procedure-engine`, not
  `@nanoboss/app-runtime`.
- Keep pure helpers out of this package unless they are specifically runtime
  presentation policy. Shared pure helpers should move down to
  `@nanoboss/procedure-sdk` or `@nanoboss/app-support`.
- Keep adapters thin. If HTTP, MCP, or TUI need the same event or tool summary
  logic, put the adapter-neutral part here and leave protocol/presentation
  formatting in the adapter.
- Treat `allowCurrentSessionFallback` as a tool-server convenience, not a
  general session selection model. Foreground sessions should pass explicit
  session state.

## Current Review Metrics

Measured during the 2026-05 app-runtime review:

- source files: 25
- source lines: 3,601
- largest file: `src/service.ts` at 599 lines
- public barrel wildcard exports: reduced from 2 to 0
- public app-runtime symbols: reduced from 58 to 57 by removing the accidental
  `UiApiImpl` value re-export
- runtime value exports: 29 -> 12 by internalizing runtime-mode, tool-call
  preview helper exports, unused runtime-event guard aliases, prompt/memory
  presentation helpers, async dispatch-result parsing/guards, and the session
  event-log implementation
- code simplification applied: split paused continuation cancellation handling
  into a private helper while preserving the `NanobossService` method
- code simplification applied: removed an obsolete private default-session
  dispatch path from `NanobossService` and deleted its unused prompt, polling,
  dispatch-result, and failure-parsing helpers
- code simplification applied: split tool-call runtime event projection out of
  the central runtime event mapper
- code simplification applied: split text normalization and bounded preview
  helpers out of the tool-call preview policy module
- code simplification applied: split foreground procedure runtime bindings out
  of `NanobossService`
- code simplification applied: split pending continuation event publication
  out of `NanobossService`
- code simplification applied: split runtime command projection and command
  update publication out of `NanobossService`
- code simplification applied: split prompt-run startup lifecycle wiring out of
  `NanobossService`

The small surface reduction matters more than the raw symbol count: the package
now exports runtime abstractions intentionally instead of forwarding every
runtime-event implementation detail by wildcard.

## Good Future Targets

- Split `NanobossService` by lifecycle concern once there is a small,
  test-backed extraction that reduces `src/service.ts` complexity.
- Revisit `allowCurrentSessionFallback` after MCP and HTTP session-selection
  behavior is fully documented.
- Audit runtime event aliases in `@nanoboss/adapters-http` so frontend naming is
  clearly transport-owned while event projection remains app-runtime-owned.
- Keep `tool-call-preview.ts` adapter-neutral; move any generic normalizer drift
  back to `@nanoboss/procedure-sdk`.
