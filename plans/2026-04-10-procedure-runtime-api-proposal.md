# Procedure runtime API proposal

## Purpose

This proposal is a map from today's sub-optimal procedure/runtime surface to a cleaner API stack.

It does four things:

1. defines the `Runtime API` as the semantic source of truth
2. defines the `Procedure API` as the in-process API procedures receive
3. defines the `Agent Runtime API` as the scoped runtime API exposed to downstream agents
4. treats MCP and CLI as adapters over the same runtime model

The goal is not to change nanoboss's execution model. The goal is to expose the existing model directly, with clearer names and better boundaries.

## Glossary

| Term | Meaning | Example pointers |
| --- | --- | --- |
| `Runtime API` | The full conceptual runtime contract for runs, refs, dispatch, schemas, and history. This is the source of truth that every other surface wraps. | Current touchpoints: [src/core/context.ts](/Users/jflam/agentboss/workspaces/nanoboss/src/core/context.ts#L91), [src/core/service.ts](/Users/jflam/agentboss/workspaces/nanoboss/src/core/service.ts#L1243), [src/mcp/server.ts](/Users/jflam/agentboss/workspaces/nanoboss/src/mcp/server.ts#L308). Target shape: `Runtime API` sections below. |
| `Procedure API` | The in-process API available to procedure authors through `ctx`. It is the main authoring surface for deterministic workflows. | Current usage: [procedures/research.ts](/Users/jflam/agentboss/workspaces/nanoboss/procedures/research.ts#L42), [procedures/simplify.ts](/Users/jflam/agentboss/workspaces/nanoboss/procedures/simplify.ts#L76), [procedures/linter.ts](/Users/jflam/agentboss/workspaces/nanoboss/procedures/linter.ts#L1). Target shape: `Procedure API` below. |
| `Agent Invocation API` | The procedure-facing sub-API used to invoke downstream agents. This is the evolution of `ctx.callAgent(...)`. | Current usage: [procedures/research.ts](/Users/jflam/agentboss/workspaces/nanoboss/procedures/research.ts#L42), [procedures/second-opinion.ts](/Users/jflam/agentboss/workspaces/nanoboss/procedures/second-opinion.ts#L27). Target shape: `Agent Invocation API` below. |
| `State API` | The procedure-facing sub-API for state, history, cells, and refs. This is the evolution of `ctx.session` and `ctx.refs`. | Current surface: [src/core/context.ts](/Users/jflam/agentboss/workspaces/nanoboss/src/core/context.ts#L91), [src/core/types.ts](/Users/jflam/agentboss/workspaces/nanoboss/src/core/types.ts#L420). Target shape: `State API` below. |
| `UI API` | The procedure-facing sub-API for text, notices, status, cards, artifacts, and telemetry. This is the evolution of `ctx.print(...)` plus the richer frontend event model. | Current usage: [procedures/simplify.ts](/Users/jflam/agentboss/workspaces/nanoboss/procedures/simplify.ts#L76), [src/http/frontend-events.ts](/Users/jflam/agentboss/workspaces/nanoboss/src/http/frontend-events.ts#L24). Target shape: `UI API` below. |
| `Procedure Invocation API` | The procedure-facing sub-API for calling or dispatching other procedures. | Current usage: [procedures/linter.ts](/Users/jflam/agentboss/workspaces/nanoboss/procedures/linter.ts#L1). Target shape: `Procedure Invocation API` below. |
| `Session API` | The procedure-facing sub-API for default-session agent configuration and token inspection. | Current surface: [src/core/context.ts](/Users/jflam/agentboss/workspaces/nanoboss/src/core/context.ts#L91), [src/core/types.ts](/Users/jflam/agentboss/workspaces/nanoboss/src/core/types.ts#L420). Target shape: `Session API` below. |
| `Agent Runtime API` | The scoped runtime API exposed to downstream agents when a procedure opts in. It is the runtime-facing counterpart to the procedure-facing `Agent Invocation API`. | Current implicit path: [src/core/service.ts](/Users/jflam/agentboss/workspaces/nanoboss/src/core/service.ts#L1243), [src/agent/default-session.ts](/Users/jflam/agentboss/workspaces/nanoboss/src/agent/default-session.ts#L225), [src/agent/call-agent.ts](/Users/jflam/agentboss/workspaces/nanoboss/src/agent/call-agent.ts#L385). Target shape: `Agent Runtime API` below. |
| `MCP adapter` | An adapter that exposes the `Runtime API` over MCP. | Current implementation: [src/mcp/server.ts](/Users/jflam/agentboss/workspaces/nanoboss/src/mcp/server.ts#L308). Target role: `Adapters` below. |
| `CLI adapter` | An adapter that exposes the `Runtime API` over a machine-readable CLI. | Illustrative commands: `Adapters` below. |

## Layering model

This proposal uses a simple layering model:

1. `Runtime API`
   The semantic contract.
2. `Procedure API` and `Agent Runtime API`
   Scoped bindings over that contract for two different callers.
3. `MCP adapter` and `CLI adapter`
   Transport adapters that carry the same runtime concepts.

That framing is useful because it keeps the architecture honest:

- the runtime concepts are primary
- the procedure and agent surfaces are scoped views of the same runtime
- the transports do not define the concepts

## Current grounding

### Procedure contract today

The current procedure contract is defined in [src/core/types.ts](/Users/jflam/agentboss/workspaces/nanoboss/src/core/types.ts#L357).

- `ProcedureMetadata`
  - `name`
  - `description`
  - `inputHint?`
  - `executionMode?`
- `Procedure`
  - `execute(prompt, ctx)`
  - optional `resume(prompt, state, ctx)`
- `ProcedureResult`
  - `data?`
  - `display?`
  - `summary?`
  - `memory?`
  - `pause?`
  - `explicitDataSchema?`

### `CommandContext` today

The current procedure context is defined in [src/core/types.ts](/Users/jflam/agentboss/workspaces/nanoboss/src/core/types.ts#L420) and implemented in [src/core/context.ts](/Users/jflam/agentboss/workspaces/nanoboss/src/core/context.ts#L91).

Procedures currently receive:

- execution context
  - `cwd`
  - `sessionId`
- state access
  - `ctx.refs.read(...)`
  - `ctx.refs.stat(...)`
  - `ctx.refs.writeToFile(...)`
  - `ctx.session.recent(...)`
  - `ctx.session.topLevelRuns(...)`
  - `ctx.session.get(...)`
  - `ctx.session.ancestors(...)`
  - `ctx.session.descendants(...)`
- agent control
  - `ctx.callAgent(prompt)`
  - `ctx.callAgent(prompt, descriptor)`
  - fresh or default session control
  - explicit downstream agent selection
  - named refs passed into prompts
- procedure composition
  - `ctx.callProcedure(name, prompt, { session })`
- session-default agent control
  - `ctx.getDefaultAgentConfig()`
  - `ctx.setDefaultAgentSelection(...)`
  - token inspection methods for the default agent session
- control
  - `ctx.assertNotCancelled()`
- streamed UI text
  - `ctx.print(text)`

### Runtime model today

The durable execution model lives in [src/session/store.ts](/Users/jflam/agentboss/workspaces/nanoboss/src/session/store.ts#L122).

Nanoboss already records a meaningful execution graph:

- cells
  - `top_level`
  - `procedure`
  - `agent`
- stored outputs
  - input
  - output data
  - display text
  - stream text
  - summary
  - memory
  - pause state
  - replay events
  - parent linkage and metadata

This means the runtime already has durable execution structure, replayable state, and nested ownership. The author-facing API is thinner and less explicit than the runtime beneath it.

### Procedure usage today

Current built-in procedures mostly use a narrow subset of the available runtime:

- `ctx.callAgent(...)`
- typed JSON descriptors
- `ctx.print(...)`
- pause and resume
- occasional `ctx.callProcedure(...)`

Representative examples:

- [procedures/research.ts](/Users/jflam/agentboss/workspaces/nanoboss/procedures/research.ts#L42)
  - default conversation for brief construction
  - fresh agent for structured research
  - durable refs passed between calls
- [procedures/second-opinion.ts](/Users/jflam/agentboss/workspaces/nanoboss/procedures/second-opinion.ts#L27)
  - default model for answer
  - explicit model for critique
  - answer and critique persisted as refs
- [procedures/simplify.ts](/Users/jflam/agentboss/workspaces/nanoboss/procedures/simplify.ts#L76)
  - pause and resume
  - progress output via `print()`
- [procedures/linter.ts](/Users/jflam/agentboss/workspaces/nanoboss/procedures/linter.ts#L1)
  - procedure composition

## Problems to solve

### 1. The procedure-facing API does not reflect the runtime clearly

Today, the author-facing surface mixes several concerns into one `CommandContext`:

- agent invocation
- state and history access
- UI output
- procedure composition
- default-session control

The runtime already has these concepts. The API should name them explicitly.

### 2. The UI surface is thinner than the runtime

Procedures can directly emit:

- `display`
- `summary`
- `memory`
- `pause`
- `print()`

But the runtime and frontend already understand richer concepts in [src/http/frontend-events.ts](/Users/jflam/agentboss/workspaces/nanoboss/src/http/frontend-events.ts#L24), including:

- `tool_started`
- `tool_updated`
- `assistant_notice`
- `token_usage`
- `run_paused`
- `memory_card_stored`
- `commands_updated`

The `UI API` should match the runtime's real semantics without exposing raw frontend event envelopes.

### 3. The state surface is too close to storage primitives

The current session/query surface is structurally correct but still store-shaped:

- `topLevelRuns`
- `ancestors`
- `descendants`
- `get`
- `recent`
- `refs.read`

Common questions should be first-class:

- latest matching run
- parent or children of a run
- owning top-level run
- resolved value from a stored ref
- recent runs filtered by procedure or summary

### 4. The downstream-agent runtime surface is still MCP-shaped

The internal dispatch path in [src/core/service.ts](/Users/jflam/agentboss/workspaces/nanoboss/src/core/service.ts#L1243) currently teaches agents to discover the global `nanoboss` MCP server and call procedure-dispatch tools.

At the same time, agent sessions mount the same global MCP surface in:

- [src/agent/default-session.ts](/Users/jflam/agentboss/workspaces/nanoboss/src/agent/default-session.ts#L225)
- [src/agent/call-agent.ts](/Users/jflam/agentboss/workspaces/nanoboss/src/agent/call-agent.ts#L385)

The core design problem is:

- nanoboss has a coherent runtime model
- downstream agents need controlled access to that runtime
- that runtime access should be described in nanoboss terms, not MCP handle-discovery terms

## Target model

## Runtime API

Define one explicit `Runtime API` and expose it through multiple scoped surfaces and adapters.

That runtime API should be available:

1. directly to procedures in process
2. to downstream agents through the `Agent Runtime API`
3. externally through the `MCP adapter` and `CLI adapter`

The runtime API is the semantic source of truth for:

- procedure dispatch
- run inspection
- ref access
- schema inspection
- execution ownership
- replay and telemetry facts

## Procedure API

The `Procedure API` is the full in-process API a procedure receives through `ctx`.

Illustrative shape:

```ts
interface ProcedureApi {
  cwd: string;
  sessionId: string;
  agent: AgentInvocationApi;
  state: StateApi;
  ui: UiApi;
  procedures: ProcedureInvocationApi;
  session: SessionApi;
  assertNotCancelled(): void;
}
```

This is the top-level authoring surface. The rest of the proposal defines the named sub-APIs inside it.

## Agent Invocation API

The `Agent Invocation API` is the procedure-facing API for invoking downstream agents.

This is the evolution of `ctx.callAgent(...)`.

Responsibilities:

- run one-shot agent calls
- continue the default conversation
- require typed structured output
- pass durable refs as inputs
- choose provider and model
- opt into the `Agent Runtime API`

Illustrative shape:

```ts
interface AgentInvocationApi {
  run(prompt: string, options?: AgentInvocationOptions): Promise<RunResult<string>>;
  run<T>(
    prompt: string,
    schema: TypeDescriptor<T>,
    options?: AgentInvocationOptions,
  ): Promise<RunResult<T>>;
  session(mode: "fresh" | "default"): BoundAgentInvocationApi;
}

interface AgentInvocationOptions {
  agent?: DownstreamAgentSelection;
  stream?: boolean;
  refs?: Record<string, CellRef | ValueRef>;
  agentRuntimeApi?: "none" | "nanoboss";
}
```

`agentRuntimeApi: "nanoboss"` means the agent call receives the scoped `Agent Runtime API`.

## State API

The `State API` is the procedure-facing API for state, history, cells, and refs.

This is the evolution of `ctx.session` and `ctx.refs`.

Responsibilities:

- inspect runs, cells, and refs
- traverse parent and child relationships
- answer common history questions
- materialize stored values

Illustrative shape:

```ts
interface StateApi {
  runs: {
    recent(options?): Promise<CellSummary[]>;
    latest(options?): Promise<CellSummary | undefined>;
    topLevel(options?): Promise<CellSummary[]>;
    get(cellRef: CellRef): Promise<CellRecord>;
    parent(cellRef: CellRef): Promise<CellSummary | undefined>;
    children(cellRef: CellRef, options?): Promise<CellSummary[]>;
    ancestors(cellRef: CellRef, options?): Promise<CellSummary[]>;
    descendants(cellRef: CellRef, options?): Promise<CellSummary[]>;
  };
  refs: {
    read<T>(ref: ValueRef): Promise<T>;
    stat(ref: ValueRef): Promise<RefStat>;
    writeToFile(ref: ValueRef, path: string): Promise<void>;
  };
}
```

This keeps the cell/ref substrate intact while making the common cases easier.

## UI API

The `UI API` is the procedure-facing API for structured communication with the frontend/runtime observer.

This is the evolution of `ctx.print(...)` plus the richer runtime/frontend semantics nanoboss already has.

Responsibilities:

- text streaming
- notices
- live status updates
- durable cards
- artifacts
- telemetry

Illustrative shape:

```ts
interface UiApi {
  text(text: string): void;
  info(text: string): void;
  warning(text: string): void;
  error(text: string): void;
  status(params: {
    procedure?: string;
    phase?: string;
    message: string;
    iteration?: string;
    autoApprove?: boolean;
    waiting?: boolean;
  }): void;
  card(params: {
    kind: "proposal" | "summary" | "checkpoint" | "report" | "notification";
    title: string;
    markdown: string;
  }): void;
  artifact(params: {
    label: string;
    ref?: ValueRef;
    path?: string;
    summary?: string;
  }): void;
  telemetry(params: {
    kind: "tokens" | "timing";
    scope: "agent" | "procedure" | "run" | "session";
    data: unknown;
  }): void;
}
```

The first implementation should explicitly support:

- live procedure status
- Markdown cards for proposals, checkpoints, reports, and summaries
- token accounting at `ctx.agent.run(...)` boundaries with rollups to procedure and run scope

`ctx.print(...)` can remain as shorthand for `ctx.ui.text(...)`.

## Procedure Invocation API

The `Procedure Invocation API` is the procedure-facing API for running or dispatching other procedures.

Illustrative shape:

```ts
interface ProcedureInvocationApi {
  run<T = KernelValue>(
    name: string,
    prompt: string,
    options?: { session?: "inherit" | "default" | "fresh" },
  ): Promise<RunResult<T>>;
  dispatch(name: string, prompt: string, options?): Promise<ProcedureDispatchHandle>;
}
```

This keeps direct in-process procedure composition separate from async dispatch.

## Session API

The `Session API` is the procedure-facing API for default-session agent control and token inspection.

Illustrative shape:

```ts
interface SessionApi {
  getDefaultAgentConfig(): DownstreamAgentConfig;
  setDefaultAgentSelection(selection: DownstreamAgentSelection): DownstreamAgentConfig;
  getDefaultAgentTokenSnapshot(): Promise<AgentTokenSnapshot | undefined>;
  getDefaultAgentTokenUsage(): Promise<AgentTokenUsage | undefined>;
}
```

This stays separate from `State API` because it manages the live default agent session rather than durable runtime history.

## Agent Runtime API

The `Agent Runtime API` is the scoped runtime API exposed to downstream agents when a procedure opts in through the `Agent Invocation API`.

It is the agent-facing counterpart to the in-process `Procedure API`.

That API should expose controlled capabilities such as:

- query session history
- read refs
- inspect run relationships
- dispatch procedures
- wait on dispatches

Illustrative shape:

```ts
interface AgentRuntimeApi {
  procedures: {
    dispatch(name: string, prompt: string, options?): Promise<ProcedureDispatchHandle>;
    wait(handle: ProcedureDispatchHandle, options?): Promise<RunResult<KernelValue>>;
  };
  runs: {
    recent(options?): Promise<CellSummary[]>;
    latest(options?): Promise<CellSummary | undefined>;
    get(cellRef: CellRef): Promise<CellRecord>;
    parent(cellRef: CellRef): Promise<CellSummary | undefined>;
    children(cellRef: CellRef, options?): Promise<CellSummary[]>;
  };
  refs: {
    read<T>(ref: ValueRef): Promise<T>;
    stat(ref: ValueRef): Promise<RefStat>;
  };
}
```

The important rule is conceptual:

- the `Agent Runtime API` is defined in runtime terms
- the transport used to deliver it is an implementation detail

This lets internal orchestration talk about nanoboss runtime capabilities instead of MCP server discovery steps.

## Execution tree and turn document

The runtime needs two explicit structures:

- execution tree
- turn document

The execution tree is the causal runtime structure:

- turns
- procedure runs
- nested agent calls
- tool activity
- refs
- telemetry ownership

The turn document is the renderer-neutral projection shown by clients:

- status
- cards
- artifacts
- telemetry summaries
- chronological display order

The proposal is:

- the runtime owns both models
- procedures author content only within their own subtree
- clients render the turn document and keep view-local state outside the runtime model

This yields a clean authority model:

- procedure-authored content
  - status
  - cards
  - artifacts
  - semantic telemetry annotations
- runtime-observed content
  - procedure start and end
  - agent and tool nodes
  - timing traces
  - token snapshots
  - parent and child ownership edges

Recommended mutation rules:

- status is mutable live state
- cards are append-only after emission
- telemetry is append-only or monotonic
- runtime-observed execution facts are immutable

## Adapters

The `Runtime API` should be transport-agnostic and exposed through two primary adapters.

### MCP adapter

The existing MCP tools in [src/mcp/server.ts](/Users/jflam/agentboss/workspaces/nanoboss/src/mcp/server.ts#L308) should become an adapter over the `Runtime API`.

Use cases:

- external integrations
- agent platforms with solid MCP support
- compatibility with the current path

### CLI adapter

Expose the same runtime API through a machine-readable CLI.

Use cases:

- local debugging
- deterministic scripting
- provider fallback when MCP behavior is unreliable
- simpler transport debugging

Illustrative commands:

```sh
nanoboss runtime procedure dispatch --session <id> --name linter --prompt "..."
nanoboss runtime session top-level-runs --session <id> --json
nanoboss runtime ref read --session <id> --cell <id> --path output.data --json
```

The CLI should implement the same conceptual runtime API as MCP rather than inventing a parallel command model.

## Current-to-target map

| Current surface | Current role | Target surface | Notes |
| --- | --- | --- | --- |
| `ctx.callAgent(...)` | Procedure-side agent invocation with implicit runtime/tool behavior | `ctx.agent.run(...)` on the `Agent Invocation API` | Adds explicit `agentRuntimeApi` selection. |
| `ctx.session.*` and `ctx.refs.*` | Mixed state/history/ref access on the main context | `ctx.state` on the `State API` | Keeps the durable substrate but adds clearer grouping and higher-level queries. |
| `ctx.print(...)` | Procedure text stream only | `ctx.ui.*` on the `UI API` | Promotes status, cards, artifacts, and telemetry to first-class concepts. |
| `ctx.callProcedure(...)` | Direct procedure composition | `ctx.procedures.run(...)` on the `Procedure Invocation API` | Separates direct composition from async dispatch. |
| `getDefaultAgentConfig()` and related methods | Default-session agent control | `ctx.session` on the `Session API` | Keeps live session management separate from durable history inspection. |
| Prompt instructions that mention global MCP tools | Implicit agent-facing runtime access | `Agent Runtime API` | Reframes the capability in runtime terms instead of transport terms. |
| `src/mcp/server.ts` tool implementation | Mixed runtime API plus transport concerns | `MCP adapter` over the `Runtime API` | MCP becomes a transport adapter, not the conceptual model. |
| No machine-readable CLI equivalent | Missing operational fallback | `CLI adapter` over the `Runtime API` | Enables deterministic local scripting and transport debugging. |

## Compatibility plan

This proposal can be adopted without breaking current procedures.

Compatibility shims:

- `ctx.callAgent(...)` -> `ctx.agent.run(...)`
- `ctx.callProcedure(...)` -> `ctx.procedures.run(...)`
- `ctx.session` and `ctx.refs` -> `ctx.state`
- `ctx.print(...)` -> `ctx.ui.text(...)`

Existing procedures can continue to run while new procedures adopt the clearer surface.

## Recommended migration phases

### Phase 1: document the runtime model and names

Write down the conceptual model explicitly:

- `Runtime API`
- `Procedure API`
- `Agent Invocation API`
- `State API`
- `UI API`
- `Procedure Invocation API`
- `Session API`
- `Agent Runtime API`
- execution tree
- turn document

This proposal is part of that phase.

### Phase 2: extract the runtime API behind MCP

Create an internal service interface for:

- procedure list, get, and dispatch
- session history inspection
- ref read, stat, and write
- schema inspection

Success criterion:

- the `MCP adapter` becomes an adapter over the `Runtime API` instead of the primary implementation

### Phase 3: introduce the CLI adapter

Expose the same runtime API through machine-readable CLI commands.

Success criterion:

- a human or agent can perform the same runtime operations without MCP registration

### Phase 4: introduce the UI API

Add structured procedure-side UI APIs while keeping `print()`.

Minimum first step:

- `text`
- `info`
- `warning`
- `error`
- `status`
- `card`

Success criteria:

- procedures can publish live status without text parsing conventions
- procedures can emit durable Markdown cards for review-style workflows

### Phase 5: introduce the State API

Refactor `ctx.session` and `ctx.refs` into a clearer state namespace.

Add at least:

- `runs.latest(...)`
- `runs.parent(...)`
- `runs.children(...)`

Success criterion:

- common history queries no longer require raw graph traversal in normal cases

### Phase 6: introduce the Agent Invocation API and Procedure API shape

Keep current `callAgent()` behavior while adding the named `ctx.agent`, `ctx.procedures`, and `ctx.session` surfaces.

Success criteria:

- the procedure-facing API is grouped by responsibility rather than one flat context
- existing methods continue to work through compatibility shims

### Phase 7: introduce the Agent Runtime API

Add explicit agent-facing runtime capabilities that can be enabled per agent call.

Success criteria:

- procedure code opts into agent runtime access explicitly
- internal prompts refer to the `Agent Runtime API` rather than MCP handle discovery

### Phase 8: add execution-tree telemetry and history annotations

Add first-class runtime accounting for:

- token usage per nested `ctx.agent.run(...)` call
- rollups per procedure subtree
- rollups per top-level run
- optional session-level rollups

Also annotate replay and history with procedure ownership for rendered tool-call activity.

Success criteria:

- the UI can show active procedure identity for live status
- complex runs can show total token consumption
- rendered tool activity can be attributed to the owning procedure subtree

### Phase 9: migrate internal dispatch wording to the new names

Update [src/core/service.ts](/Users/jflam/agentboss/workspaces/nanoboss/src/core/service.ts#L1243) so internal orchestration instructions talk about the `Agent Runtime API` instead of raw MCP procedures.

Success criterion:

- transport-specific details are hidden behind the runtime abstraction

## Success criteria

This proposal succeeds if nanoboss ends up with:

- a `Runtime API` that is independent of transport
- a named `Procedure API` with explicit `agent`, `state`, `ui`, `procedures`, and `session` sub-APIs
- a scoped `Agent Runtime API` for downstream agents
- a renderer-neutral turn document owned by the runtime
- explicit procedure-scoped status, cards, artifacts, and telemetry
- state queries that are more ergonomic than raw graph traversal
- token accounting that starts at `ctx.agent.run(...)` boundaries and rolls up over execution subtrees
- replay and history that preserve ownership of rendered tool activity
- `MCP adapter` and `CLI adapter` implementations over the same runtime model

## Bottom line

Nanoboss already has the runtime model this proposal needs:

- durable execution structure
- nested runs
- refs
- replay
- pause and resume

The work here is to expose that model directly and give each surface a clear name.

The recommended direction is:

1. define the `Runtime API` as the source of truth
2. define the `Procedure API` as the procedure authoring surface
3. define the `Agent Runtime API` as the scoped downstream-agent surface
4. implement `MCP adapter` and `CLI adapter` layers over the same core
