# Runtime API migration prep refactor plan

## Purpose

This document is an implementation plan for preparatory refactors that should happen before the `Runtime API` / `Procedure API` migration.

It is meant for an implementation agent. The goal is to create better seams in the current codebase without changing the external behavior of procedures yet.

This plan is intentionally narrower than [2026-04-10-procedure-runtime-api-proposal.md](/Users/jflam/agentboss/workspaces/nanoboss/plans/2026-04-10-procedure-runtime-api-proposal.md). The proposal defines the target architecture. This document defines the cleanup work that should happen first so that migration to the new API surfaces is low-risk and incremental.

## Outcome

After this refactor pass, the codebase should have:

- a transport-neutral runtime service boundary extracted from MCP-specific code
- internal sub-API implementations inside the current `CommandContext`
- an explicit seam for agent runtime capability exposure
- a dedicated procedure-side UI emission layer behind `print()`
- state/query helpers that match the future `State API` more closely
- no user-visible behavior changes for existing procedures

## Non-goals

Do not do these in this refactor pass:

- do not rename the public procedure authoring API yet
- do not delete compatibility methods such as `ctx.callAgent(...)` or `ctx.print(...)`
- do not introduce the full `UI API` surface yet
- do not change the durable session store format unless necessary for compatibility
- do not migrate internal orchestration prompts to the new names yet, beyond creating seams
- do not add the CLI adapter yet

## Constraints

- behavior must remain backward-compatible for current procedures
- the diff should prefer extraction and delegation over semantic rewrites
- each new seam should be covered by focused tests
- the implementation should preserve the current MCP transport path while making it replaceable

## Current seam points

These are the key places in the current codebase that should be used as extraction points:

- [src/core/context.ts](/Users/jflam/agentboss/workspaces/nanoboss/src/core/context.ts#L81)
  - `CommandContextImpl` currently owns agent invocation, procedure invocation, state access, default-session management, and UI emission
- [src/core/types.ts](/Users/jflam/agentboss/workspaces/nanoboss/src/core/types.ts#L392)
  - current `CommandContext` and related option types
- [src/mcp/server.ts](/Users/jflam/agentboss/workspaces/nanoboss/src/mcp/server.ts#L61)
  - `NanobossMcpApi` is already close to a transport-neutral runtime service but still lives in the MCP layer
- [src/core/service.ts](/Users/jflam/agentboss/workspaces/nanoboss/src/core/service.ts#L1231)
  - `buildProcedureDispatchPrompt(...)` is the sharpest MCP-coupled orchestration point
- [src/agent/default-session.ts](/Users/jflam/agentboss/workspaces/nanoboss/src/agent/default-session.ts#L230)
  - default agent sessions always mount the global MCP server
- [src/agent/call-agent.ts](/Users/jflam/agentboss/workspaces/nanoboss/src/agent/call-agent.ts#L380)
  - fresh agent sessions also always mount the global MCP server
- [src/http/frontend-events.ts](/Users/jflam/agentboss/workspaces/nanoboss/src/http/frontend-events.ts#L24)
  - frontend/runtime event vocabulary that should eventually be exposed through a procedure-facing UI layer

## Recommended implementation order

### Step 1: extract a transport-neutral runtime service

Create a new internal runtime service module that owns the semantic operations currently exposed through `NanobossMcpApi`.

Suggested file direction:

- add `src/runtime/api.ts`
- add `src/runtime/service.ts`
- keep `src/mcp/server.ts` as an adapter over the new service

Minimum surface for the new runtime service:

- procedure list and get
- procedure dispatch start, status, and wait
- recent runs
- top-level runs
- cell get
- ancestors and descendants
- ref read, stat, and write-to-file
- schema inspection

Implementation guidance:

- move logic, do not redesign semantics yet
- keep the method signatures close to the current `NanobossMcpApi` shape
- make the MCP layer do argument parsing and adapter wiring only

Acceptance criteria:

- `src/mcp/server.ts` depends on the runtime service instead of owning the primary implementation
- no runtime behavior changes for existing MCP tools
- tests continue to pass with the same MCP tool behavior

### Step 2: split `CommandContextImpl` into internal sub-API implementations

Refactor [src/core/context.ts](/Users/jflam/agentboss/workspaces/nanoboss/src/core/context.ts#L81) so `CommandContextImpl` becomes a composition root rather than the implementation of every concern.

Suggested internal classes:

- `AgentInvocationApiImpl`
- `StateApiImpl`
- `UiApiImpl`
- `ProcedureInvocationApiImpl`
- `SessionApiImpl`

Suggested first step:

- keep `CommandContext` unchanged
- keep `CommandContextImpl` implementing the old interface
- internally delegate each method to one of the new collaborators

Implementation guidance:

- `CommandRefs` and `CommandSession` are already partial seams; use them instead of replacing them immediately
- `beginAgentRun(...)`, `completeAgentRun(...)`, and `failAgentRun(...)` should move under the new agent invocation component or a helper it owns
- `print(...)` should become a delegation to `UiApiImpl.text(...)`

Acceptance criteria:

- `CommandContextImpl` is mostly wiring plus compatibility methods
- the new collaborators are individually testable
- no behavior changes for existing procedures

### Step 3: add a dedicated UI emission layer behind `print()`

Introduce an internal procedure-side UI layer without changing the public procedure API yet.

Suggested file direction:

- add `src/core/ui-api.ts`
- add `src/core/ui-emitter.ts`

Minimum first surface:

- `text(text: string): void`

Responsibilities:

- append text to the active cell stream
- write the print log entry
- emit the current ACP/frontend text update

Implementation guidance:

- keep `ctx.print(...)` as a compatibility shim
- avoid introducing cards or status here yet
- isolate text emission side effects in one place

Acceptance criteria:

- `print()` becomes a thin wrapper over the new internal UI layer
- text emission behavior remains unchanged
- later `info`, `warning`, `status`, and `card` methods can be added without revisiting call sites

### Step 4: expand the current state/query seam toward the future `State API`

Extend the existing session/ref wrapper layer so common state queries no longer require direct graph traversal.

Suggested changes:

- add `latest(...)`
- add `parent(...)`
- add `children(...)`

Likely implementation points:

- [src/core/context.ts](/Users/jflam/agentboss/workspaces/nanoboss/src/core/context.ts#L599)
- `SessionStore` methods or thin helper functions layered on top of it

Implementation guidance:

- do not remove existing methods
- if `SessionStore` does not yet expose these directly, add helper functions in a focused module rather than bloating unrelated files
- keep current return shapes consistent with existing cell summary types

Acceptance criteria:

- the wrappers required by the future `State API` exist internally
- no current callers break
- the implementation avoids leaking store traversal details into procedure code

### Step 5: extract session-default agent management from the flat context

Separate live default-agent-session management from durable history/query access.

Suggested scope:

- wrap `getDefaultAgentConfig()`
- wrap `setDefaultAgentSelection(...)`
- wrap token snapshot and token usage methods

Implementation guidance:

- this can initially be an internal `SessionApiImpl`
- keep the old `CommandContext` methods as delegates
- do not change default-session semantics yet

Acceptance criteria:

- live session control is isolated from state/history logic
- the future `Session API` naming can be introduced later with minimal behavior changes

### Step 6: create an explicit agent runtime capability seam

The current design hardwires “agent gets runtime capabilities” to “mount the global MCP server.”

Refactor that into an explicit configuration seam without changing behavior yet.

Suggested direction:

- define an internal concept such as `AgentRuntimeCapabilityMode` or `AgentRuntimeAdapter`
- make fresh and default session establishment accept a runtime capability configuration
- keep the only implementation as “mount the existing global MCP server”

Primary touchpoints:

- [src/agent/default-session.ts](/Users/jflam/agentboss/workspaces/nanoboss/src/agent/default-session.ts#L230)
- [src/agent/call-agent.ts](/Users/jflam/agentboss/workspaces/nanoboss/src/agent/call-agent.ts#L380)

Implementation guidance:

- the point is not to add a new transport yet
- the point is to stop baking the MCP transport choice into every call site
- default behavior should remain exactly what it is today

Acceptance criteria:

- agent session setup can be configured with a runtime capability mode
- the current MCP-backed behavior remains the default implementation
- later introduction of the `Agent Runtime API` will not require invasive edits to session creation code

### Step 7: isolate MCP-specific orchestration instructions

Refactor [buildProcedureDispatchPrompt(...) in src/core/service.ts](/Users/jflam/agentboss/workspaces/nanoboss/src/core/service.ts#L1231) behind an abstraction so orchestration logic stops depending directly on MCP wording.

Suggested direction:

- add a module such as `src/core/agent-runtime-instructions.ts`
- move the current MCP-specific dispatch instructions there
- rename the current builder to reflect that it is an MCP-backed implementation

Implementation guidance:

- do not change prompt semantics yet
- the output can remain identical in the first pass
- the important thing is that orchestration code depends on an abstract instruction source rather than inline MCP prose

Acceptance criteria:

- the MCP-specific prompt text lives outside the main service logic
- a future `Agent Runtime API` wording change can be implemented in one place

### Step 8: extract agent-run recording and telemetry seam

The current agent invocation flow already has a natural recording boundary:

- `beginAgentRun(...)`
- `completeAgentRun(...)`
- `failAgentRun(...)`

This should be isolated so later execution-tree telemetry and ownership work can build on it.

Suggested direction:

- move agent-run start/end bookkeeping into a dedicated helper or recorder class
- keep the current persisted output behavior
- preserve current token usage capture behavior

Implementation guidance:

- the first goal is structural isolation, not richer telemetry
- keep the child-cell lifecycle and emitted tool-call updates identical

Acceptance criteria:

- one component owns agent-run lifecycle recording
- later rollup logic can be added without re-splitting `CommandContextImpl`

## Suggested file layout

This is illustrative, not mandatory:

```text
src/runtime/
  api.ts
  service.ts

src/core/
  context.ts
  context-agent.ts
  context-state.ts
  context-ui.ts
  context-procedures.ts
  context-session.ts
  ui-api.ts
  ui-emitter.ts
  agent-runtime-instructions.ts
```

If the agent prefers fewer files, it is acceptable to collapse these into fewer modules. The important thing is to create stable seams, not to optimize the final file layout yet.

## Test plan

Add or update focused tests around these areas:

- MCP tool behavior still matches the pre-refactor behavior
- `callAgent(...)` behavior is unchanged for both `fresh` and `default` session modes
- `callProcedure(...)` behavior is unchanged for `inherit`, `default`, and `fresh`
- `print(...)` still appends stream text, logs correctly, and emits the same frontend/ACP update
- new state helper methods return the expected cells for representative nested-run fixtures
- session establishment still mounts the MCP-backed runtime capability path by default

If integration tests already cover some of these areas, prefer expanding existing test suites over creating isolated tests that duplicate the same fixtures.

## Execution checklist

1. Extract runtime service from `src/mcp/server.ts`.
2. Introduce internal context collaborator classes and delegate from `CommandContextImpl`.
3. Add internal UI emitter and make `print()` delegate to it.
4. Add `latest`, `parent`, and `children` state helpers.
5. Isolate default-session agent management in a session-specific collaborator.
6. Add a configurable runtime capability seam for agent sessions while keeping MCP as the only implementation.
7. Move MCP-specific orchestration prompt text behind an abstraction.
8. Extract agent-run lifecycle bookkeeping into a focused component.
9. Run tests after each step or small cluster of steps, not only at the end.

## Done criteria

This prep refactor is complete when:

- runtime semantics are available through a transport-neutral internal service
- context responsibilities are split into internal sub-APIs
- the current procedure API still works without behavior changes
- MCP remains functional as an adapter over the extracted runtime service
- the codebase has clear seams for introducing the future `Procedure API`, `State API`, `UI API`, and `Agent Runtime API`

## Notes for the implementing agent

- prefer extraction and delegation over renaming and churn
- preserve current behavior first, then improve structure
- avoid mixing transport changes with API naming changes
- if a step reveals hidden coupling, stop and create a smaller seam before continuing
