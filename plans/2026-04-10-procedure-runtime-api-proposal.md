# Procedure runtime API proposal

## Preamble

This document is meant to do two things before it proposes any changes:

1. re-establish the current mental model of procedures in nanoboss as they exist today
2. explain why the current architecture feels strained, especially around MCP, session-state inspection, and how procedures communicate with both the UI and downstream agents

That preamble matters because the proposal only makes sense if it stays grounded in the code as it exists now.

The high-level picture today is:

- a **procedure** is a deterministic, named workflow implemented as a TypeScript module
- procedures run inside the nanoboss runtime with a small `CommandContext`
- procedures can call downstream agents, call other procedures, inspect durable session state, emit streamed text, and pause/resume
- all durable execution history is stored as a graph of **cells** and **refs**
- the current agent-facing way to call back into nanoboss at runtime is primarily the global `nanoboss` MCP server

That last point is the important source of tension.

Nanoboss already has a coherent internal runtime model:

- top-level procedure runs
- nested procedure calls
- nested agent calls
- durable stored outputs
- replayable event streams
- paused continuations
- session-local default conversation state

But the API exposed to procedure authors is thinner than the runtime beneath it, while the API exposed to agents is shaped heavily by MCP transport constraints and prompt scaffolding. The result is:

- the **procedure API** looks smaller and simpler than the real runtime
- the **agent integration surface** is more complicated and more transport-specific than it should be
- the **UI/runtime boundary** leaks through text conventions like `print()` and `Info:`/`Warning:`/`Error:` message parsing

The practical feeling is that nanoboss has a fairly strong runtime core, but its abstraction boundaries are inverted:

- runtime state is durable and structured
- UI communication is richer than the procedure API admits
- internal agent/runtime control is routed through MCP-shaped instructions rather than a first-class runtime interface

This proposal argues for making the runtime API more explicit and treating MCP as an adapter, not the primary conceptual surface.

There is one more missing abstraction that sits above the proposed UI API:

- nanoboss needs a renderer-neutral logical document model for what a session and turn produce

Without that organizing principle, `status(...)`, `card(...)`, and `telemetry(...)` risk becoming a bag of primitives rather than edits to a coherent document.

## Current grounding

### What a procedure is today

The current procedure contract is defined in [src/core/types.ts](/Users/jflam/agentboss/workspaces/nanoboss/src/core/types.ts#L357):

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

That is the formal author-facing API surface.

### What `CommandContext` actually gives procedures

The current `CommandContext` in [src/core/types.ts](/Users/jflam/agentboss/workspaces/nanoboss/src/core/types.ts#L420) and [src/core/context.ts](/Users/jflam/agentboss/workspaces/nanoboss/src/core/context.ts#L91) provides:

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
  - fresh vs default-session control
  - per-call downstream agent selection
  - named refs passed into the prompt
- procedure composition
  - `ctx.callProcedure(name, prompt, { session })`
- session-default agent control
  - `ctx.getDefaultAgentConfig()`
  - `ctx.setDefaultAgentSelection(...)`
  - token inspection methods for the default agent session
- control / cancellation
  - `ctx.assertNotCancelled()`
- streamed UI text
  - `ctx.print(text)`

This is a good small surface, but it is also notably uneven:

- `callAgent` is rich
- state access is low-level and store-shaped
- UI communication is mostly `print()`
- there is no explicit “nanoboss runtime tools” surface for agents

### What the runtime beneath procedures actually is

The durable execution model lives in [src/session/store.ts](/Users/jflam/agentboss/workspaces/nanoboss/src/session/store.ts#L122).

Every procedure and agent action becomes a **cell**:

- `top_level`
- `procedure`
- `agent`

Each cell stores:

- input
- output data
- display text
- stream text
- summary
- memory
- pause state
- replay events
- metadata such as parent linkage and creation time

This means nanoboss already has a meaningful execution graph, not just transient procedure calls.

### What procedures really do in practice

The procedures under `procedures/` suggest the practical API surface is narrower than the formal one:

- most procedures rely primarily on `ctx.callAgent(...)`, typed JSON descriptors, and `ctx.print(...)`
- only a few use `ctx.callProcedure(...)`
- current built-ins barely use `ctx.session.*` directly
- current built-ins barely use `ctx.refs.*` directly, except indirectly through `dataRef` passing into `callAgent`

Representative examples:

- [procedures/research.ts](/Users/jflam/agentboss/workspaces/nanoboss/procedures/research.ts#L42)
  - uses default conversation to build a brief
  - uses a fresh agent for structured research
  - passes durable refs into the second call
- [procedures/second-opinion.ts](/Users/jflam/agentboss/workspaces/nanoboss/procedures/second-opinion.ts#L27)
  - uses the session default model for the first answer
  - uses an explicit Codex model for critique
  - persists answer and critique refs
- [procedures/simplify.ts](/Users/jflam/agentboss/workspaces/nanoboss/procedures/simplify.ts#L76)
  - shows the pause/resume pattern clearly
  - emits progress with `print()`
- [procedures/linter.ts](/Users/jflam/agentboss/workspaces/nanoboss/procedures/linter.ts)
  - demonstrates procedure composition by calling `/nanoboss/commit`

So in practice, the live procedure authoring model is:

- deterministic workflow orchestration
- structured agent calls
- resumable loops
- occasional composition
- text-stream status output

That is a useful baseline, but it does not expose the full runtime clearly.

## What is strained today

### 1. The UI/runtime factoring is incomplete

Procedures can only directly communicate through:

- `display`
- `summary`
- `memory`
- `pause`
- `print()`

But the runtime and UI already understand richer event types in [src/http/frontend-events.ts](/Users/jflam/agentboss/workspaces/nanoboss/src/http/frontend-events.ts#L24):

- `tool_started`
- `tool_updated`
- `assistant_notice`
- `token_usage`
- `run_paused`
- `memory_card_stored`
- `commands_updated`

Today, those richer concepts mostly arise from:

- ACP session updates
- inferred tool-call summaries
- runtime event translation
- special parsing of text like `Info: ...` in [src/agent/acp-updates.ts](/Users/jflam/agentboss/workspaces/nanoboss/src/agent/acp-updates.ts#L10)

That means nanoboss already has a richer UI protocol, but procedures do not get a first-class way to speak it.

### 2. The session/history query API is too store-shaped

The current session query surface is structurally correct, but low-level:

- `topLevelRuns`
- `ancestors`
- `descendants`
- `get`
- `recent`
- `refs.read`

This matches the durable cell graph, but it is not yet ergonomic for agents or workflow authors who want higher-level questions such as:

- “find the latest `/second-opinion` run”
- “find the child agent call that produced the critique”
- “find the top-level run that owns this nested cell”
- “get me the resolved value of the latest stored answer”
- “search recent history by procedure + summary”

Today, the runtime model is strong, but the query API is still too close to the storage primitives.

### 3. Internal agent/runtime control is MCP-shaped

This is the biggest design smell.

The internal dispatch path in [src/core/service.ts](/Users/jflam/agentboss/workspaces/nanoboss/src/core/service.ts#L1243) literally instructs the downstream agent to:

- find the global `nanoboss` MCP server
- call `procedure_dispatch_start`
- then poll `procedure_dispatch_wait`

Separately, both fresh and default ACP sessions always mount the global MCP server:

- [src/agent/default-session.ts](/Users/jflam/agentboss/workspaces/nanoboss/src/agent/default-session.ts#L225)
- [src/agent/call-agent.ts](/Users/jflam/agentboss/workspaces/nanoboss/src/agent/call-agent.ts#L385)

This means MCP currently plays three roles:

1. external integration surface
2. agent-accessible session inspection surface
3. internal control plane for nanoboss-to-nanoboss orchestration

That overload is likely why it feels like a giant pain:

- the runtime concept is simple
- the transport-specific operational path is not
- prompt engineering is compensating for a missing first-class abstraction

### 4. `callAgent()` is sophisticated, but one-dimensional

`ctx.callAgent(...)` is already the strongest part of the API:

- typed output
- fresh vs default session reuse
- named refs
- agent/model selection

But from a procedure author’s perspective it still mostly means:

- “send a prompt”
- “optionally require JSON”
- “get raw text plus data refs back”

What is missing is a more explicit model for sophisticated AI interaction such as:

- tool or capability injection
- structured nanoboss runtime access
- richer conversational subroutines
- scoped permissions
- explicit plans / checkpoints / notices
- deliberate bridging back into runtime procedures or state queries

In short: `callAgent()` is powerful, but not yet clearly shaped as a runtime-aware agent API.

## Design goals

The next procedure/runtime API should aim for the following:

### 1. Keep procedures deterministic

Procedures should remain deterministic intelligent workflows, not devolve into “let the model improvise everything.”

That implies:

- explicit workflow structure
- explicit state transitions
- explicit procedure composition
- explicit durable outputs
- explicit pause/resume state

### 2. Make runtime access first-class

Agents and procedures should be able to inspect session state and session history through a first-class nanoboss runtime abstraction, not primarily through MCP-specific prompt instructions.

### 3. Make UI communication explicit

Procedures should have a structured UI/event API richer than `print()`, while still allowing `print()` as a convenience.

The UI model should distinguish between:

- CLI chrome
- live procedure status
- durable Markdown cards
- structured telemetry

Just as important, the UI shape should be independent of the rendering engine.

Today, nanoboss renders through pi-tui. In the future, nanoboss should also support a web UI. That means the procedure/runtime layer should not emit pi-tui-specific presentation assumptions. It should emit a frontend-neutral UI model that multiple renderers can consume.

The rule should be:

- procedures emit semantic UI state
- frontends choose how to render it

For example:

- a Markdown card is a runtime concept, not a pi-tui widget
- live procedure status is a runtime concept, not a particular status bar layout
- telemetry is runtime state, not a TUI-specific footer line

This is important both for long-term maintainability and for keeping procedure authors focused on meaning rather than presentation mechanics.

### 4. Give the UI model an organizing document structure

The UI API should not just be a list of semantic output primitives.

Nanoboss also needs a clear model of the logical structure that those outputs belong to.

The key distinction is:

- the **execution tree** is the causal runtime structure
- the **turn document** is the renderer-neutral projection shown by frontends

Those are closely related, but they are not the same thing.

The execution tree contains:

- sessions
- turns
- procedure run trees
- nested agent calls
- nested tool calls
- refs
- telemetry ownership

The turn document contains:

- turn-level rendered items
- procedure-scoped sections or nodes
- cards
- status snapshots
- telemetry summaries
- chronological display ordering

The turn document should be a projection over the execution tree, not a replacement for it.

This matters because:

- execution is hierarchical and causal
- rendering is often chronological and curated

A nested procedure may own a tool call, proposal, or token subtree, while the renderer may still choose to show those items inline in a flat timeline. That requires both:

- ownership metadata from the execution structure
- display ordering in the document structure

### 4. Treat MCP as an adapter

MCP is still useful and likely necessary for interoperability, but it should not be the primary conceptual API for internal runtime access.

### 5. Allow multiple transports for the same conceptual runtime API

The conceptual runtime surface should be transport-agnostic and exposable through:

- in-process TypeScript APIs
- MCP tools
- JSON CLI commands

That keeps the core design clean while giving operational flexibility.

## Proposal

## Core idea

Define one explicit **nanoboss runtime API** and expose it through multiple adapters.

The important architectural change is:

- stop thinking of MCP as the runtime API
- start thinking of MCP as one transport for a runtime API

The runtime API should be available:

1. directly to procedures in-process
2. indirectly to downstream agents through a controlled bridge
3. externally through MCP and/or CLI adapters

## Proposed conceptual split

Split the current `CommandContext` into three clearer conceptual domains:

### 1. `ctx.agent`

For downstream AI interaction.

This is the evolution of today’s `ctx.callAgent(...)`.

Responsibilities:

- run isolated one-shot agent calls
- continue the session default conversation
- require typed structured output
- pass durable refs as inputs
- choose provider/model
- optionally expose a nanoboss runtime bridge to the agent

### 2. `ctx.state`

For session history and durable runtime state.

This is the evolution of today’s `ctx.session` and `ctx.refs`.

Responsibilities:

- inspect cells, refs, and runs
- answer common higher-level history questions
- materialize stored values
- discover related runs and nested work
- possibly expose search helpers later

### 3. `ctx.ui`

For structured communication with the frontend/runtime observer.

This is the evolution of today’s `ctx.print()` and indirectly produced frontend events.

The important idea is that not all UI is the same kind of UI. Nanoboss should model at least four layers explicitly.

#### a. CLI chrome

This is local shell state rather than procedure-authored output.

Examples:

- busy vs idle
- queued prompts
- key hints
- input affordances
- transport / connection state

Most of this already exists conceptually and should remain outside procedure-authored durable output.

#### b. Procedure status

This is the live state of the active run.

Examples:

- active running procedure name
- current phase
- iteration counters
- auto-approve enabled or disabled
- waiting for human input vs actively running
- currently active nested work

For `simplify2`, this is where things like the following belong:

- `/simplify2`
- `iteration 3 of 8`
- `auto-approve: on`
- `phase: applying hypothesis`
- `status: waiting for checkpoint reply`

This is distinct from durable output cards. It is a live summary of what the run is doing now.

#### c. Cards

These are durable human-facing outputs that should be easy to read later.

Cards should support Markdown rendering.

Examples:

- proposals for review
- summaries
- research reports
- checkpoints
- final outcomes
- durable notifications worth preserving

This is especially important for procedures like `simplify2`. A proposal for the user to review should not be squeezed into plain status text. It should be emitted as a Markdown card with a clear title and body.

#### d. Telemetry

This is structured runtime accounting rather than human prose.

Examples:

- token accounting
- timing breakdowns
- subtree resource usage
- model/provider attribution

This is important because the current token story is weak:

- the status bar can show tokens without clearly identifying which session they belong to
- a complex top-level procedure can perform many nested `callAgent()` calls without a clear aggregate token total

Conceptually, token accounting should follow the execution tree:

- session
- top-level run
- nested procedure call
- nested agent call

If `callAgent()` is the only agent entry point, nanoboss can own this accounting cleanly. That would allow:

- token counts per agent call
- rollups per procedure
- rollups for the full top-level run
- optionally rollups for the whole session

This means telemetry should be treated as another form of durable runtime state, not merely a transient status-bar number.

The initial telemetry boundary should be explicit:

- the first accounting boundary should be the `callAgent()` boundary

That is the most defensible first cut because it is the point where nanoboss already fully controls agent execution.

So the first version should aim for:

- token snapshots and totals per `callAgent()` invocation
- rollups from agent calls into procedure subtrees
- rollups from procedure subtrees into a top-level run
- optional session-level aggregation

Finer attribution may be possible later, for example:

- per-tool token deltas
- model-cost attribution inside a single agent turn
- more exact token costs around tool invocation boundaries

But the proposal should not over-promise that granularity yet. The initial model should be honest about the current runtime’s observable boundaries.

#### Implication for history and replay

Session history should preserve enough structure to explain where rendered tool calls came from.

In particular, history and replay should be annotated with:

- the active top-level procedure
- the nested procedure, if any, that owned a given tool call
- the agent call subtree the tool call belonged to

Today, tool-call rendering is useful, but it is harder than it should be to answer “which procedure caused this tool call card to appear?” That linkage should become explicit in the stored/replayed event model.

#### Resulting API direction

Responsibilities for `ctx.ui` should include:

- text streaming
- notices
- live status updates
- Markdown cards
- artifacts
- checkpoints
- structured telemetry emission

`ctx.print()` can remain as shorthand for `ctx.ui.text(...)`.

The output of `ctx.ui` should be renderer-neutral. pi-tui and a future web frontend should consume the same semantic event/state model and render it differently as needed.

That said, `ctx.ui` alone is not the whole organizing principle. These operations should append to or mutate a logical turn document owned by the runtime.

## Proposed shape

This is illustrative, not final:

```ts
interface ProcedureContext {
  cwd: string;
  sessionId: string;
  agent: AgentApi;
  state: RuntimeStateApi;
  ui: ProcedureUiApi;
  procedures: ProcedureInvocationApi;
  session: SessionControlApi;
  assertNotCancelled(): void;
}
```

### `AgentApi`

```ts
interface AgentApi {
  run(prompt: string, options?: AgentRunOptions): Promise<RunResult<string>>;
  run<T>(prompt: string, schema: TypeDescriptor<T>, options?: AgentRunOptions): Promise<RunResult<T>>;
  session(mode: "fresh" | "default"): BoundAgentApi;
}

interface AgentRunOptions {
  agent?: DownstreamAgentSelection;
  stream?: boolean;
  refs?: Record<string, CellRef | ValueRef>;
  bridge?: "none" | "nanoboss";
}
```

Key idea:

- `bridge: "nanoboss"` means “this agent may use controlled nanoboss runtime capabilities”
- the bridge should be defined by nanoboss concepts, not by MCP concepts

### `RuntimeStateApi`

```ts
interface RuntimeStateApi {
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

This keeps the current low-level graph model available while adding obvious higher-level affordances.

### `ProcedureUiApi`

```ts
interface ProcedureUiApi {
  text(text: string): void;
  info(text: string): void;
  warning(text: string): void;
  error(text: string): void;
  status(params: { procedure?: string; phase?: string; message: string; iteration?: string; autoApprove?: boolean; waiting?: boolean }): void;
  card(params: { kind: "proposal" | "summary" | "checkpoint" | "report" | "notification"; title: string; markdown: string }): void;
  artifact(params: { label: string; ref?: ValueRef; path?: string; summary?: string }): void;
  telemetry(params: { kind: "tokens" | "timing"; scope: "agent" | "procedure" | "run" | "session"; data: unknown }): void;
}
```

This does not require exposing the entire frontend event model directly to procedures, but it gives procedures a first-class structured communication layer instead of overloading text streams.

The most important additions here are:

- `status(...)` for live procedure state, including active procedure identity
- `card(...)` for durable Markdown-rendered output
- `telemetry(...)` for token and timing accounting that can roll up over the execution tree

These APIs should be defined in terms of semantic content, not specific widgets or layout assumptions from pi-tui.

The longer-term direction may want the procedure-facing surface to be scoped more explicitly to the current procedure node within the turn document.

Illustrative examples:

```ts
const proc = ctx.document.currentProcedure();
proc.setStatus({...});
proc.appendCard({...});
proc.recordTelemetry({...});
```

or:

```ts
ctx.turn.procedure.current().setStatus({...});
ctx.turn.procedure.current().appendCard({...});
ctx.turn.procedure.current().recordTelemetry({...});
```

The exact API shape can be refined later, but the important idea is:

- the runtime owns a logical document model
- procedures edit their own scoped portion of that model
- renderers consume the projected document rather than raw widget instructions

### `ProcedureInvocationApi`

```ts
interface ProcedureInvocationApi {
  run<T = KernelValue>(name: string, prompt: string, options?: { session?: "inherit" | "default" | "fresh" }): Promise<RunResult<T>>;
  dispatch(name: string, prompt: string, options?): Promise<ProcedureDispatchHandle>;
}
```

This keeps direct in-process procedure composition separate from async dispatch.

### `SessionControlApi`

This would absorb the current session-default agent controls:

```ts
interface SessionControlApi {
  getDefaultAgentConfig(): DownstreamAgentConfig;
  setDefaultAgentSelection(selection: DownstreamAgentSelection): DownstreamAgentConfig;
  getDefaultAgentTokenSnapshot(): Promise<AgentTokenSnapshot | undefined>;
  getDefaultAgentTokenUsage(): Promise<AgentTokenUsage | undefined>;
}
```

This may or may not deserve its own namespace, but conceptually it is different from `state`.

## Missing abstraction: execution tree vs turn document

The earlier `ctx.ui` proposal is useful, but incomplete on its own.

The missing abstraction is the logical document being produced during a session.

The useful mental model is:

- a session contains turns
- each turn has one root procedure run
- that root procedure may spawn nested procedures and agent calls
- each procedure run owns its own status, cards, telemetry, and children
- the UI consumes a turn document projection of that structure

That gives the proposal a stronger organizing principle:

- not “emit random UI primitives”
- but “mutate the current procedure’s portion of the turn document”

This also gives a clean place to preserve procedure ownership for rendered tool calls, cards, and telemetry.

## The most important new concept: the nanoboss bridge

The missing concept today is not “more MCP.”

The missing concept is:

- when nanoboss asks an agent to do work, what controlled runtime capabilities is that agent allowed to use?

Today, the answer is implicit:

- the runtime mounts a global MCP server
- prompts teach the agent how to use it

The proposal is to make that explicit:

- `bridge: "nanoboss"` on agent calls
- or equivalent higher-level helpers such as `ctx.agent.withNanobossBridge().run(...)`

Conceptually, that bridge should expose runtime capabilities such as:

- query session history
- read refs
- inspect cell relationships
- dispatch another procedure
- wait on a dispatch

The important design rule is:

- the bridge API is defined by nanoboss runtime concepts
- the transport used to deliver it is an implementation detail

That transport may still be MCP for some providers. It may be a JSON CLI for others. It may someday be a direct protocol. The conceptual API should not care.

## MCP and CLI roles

## Recommendation

Do not remove MCP.

Do stop treating MCP as the primary internal abstraction.

Use this layering:

### 1. Runtime API

The source of truth.

This is the conceptual nanoboss API for:

- procedure dispatch
- state inspection
- ref reading
- schema inspection

### 2. MCP adapter

For:

- external tool ecosystems
- agent platforms that already consume MCP well
- compatibility with the current path

The existing MCP tools in [src/mcp/server.ts](/Users/jflam/agentboss/workspaces/nanoboss/src/mcp/server.ts#L308) are a good first adapter layer.

### 3. JSON CLI adapter

For:

- local debugging
- deterministic scripting
- fallback for agents whose MCP integration is unreliable
- simpler transport debugging

Example shape:

```sh
nanoboss runtime procedure dispatch --session <id> --name linter --prompt "..."
nanoboss runtime session top-level-runs --session <id> --json
nanoboss runtime ref read --session <id> --cell <id> --path output.data --json
```

This gives nanoboss a transport that is:

- debuggable
- shell-friendly
- scriptable
- not dependent on MCP registration behavior

The key is that this CLI should implement the same runtime API as MCP, not a parallel ad hoc command set.

## Why this is better than doubling down on MCP

If nanoboss continues to deepen its internal reliance on MCP:

- prompt engineering remains transport-specific
- agent capability wiring remains harder to reason about
- internal orchestration stays coupled to provider/tool behavior
- runtime design decisions get distorted by MCP naming and polling constraints

If nanoboss moves to a runtime-first design:

- internal APIs become clearer
- MCP becomes easier to maintain because it wraps a stable core
- CLI fallback becomes possible without inventing a second model
- agent prompts can talk about nanoboss capabilities, not MCP handles

## Backward-compatible interpretation of the current API

This proposal does not require discarding the current `CommandContext`.

It can be evolved compatibly:

- `ctx.callAgent(...)` becomes a compatibility shim over `ctx.agent.run(...)`
- `ctx.callProcedure(...)` becomes a compatibility shim over `ctx.procedures.run(...)`
- `ctx.session` and `ctx.refs` become compatibility views over `ctx.state`
- `ctx.print(...)` becomes a compatibility shim over `ctx.ui.text(...)`

That allows existing procedures to continue working while new procedures use the clearer shape.

## Stateful clients

The proposal should assume stateful clients.

That is already effectively true today:

- the runtime emits structured events
- pi-tui maintains client-side UI state and derives the rendered output from those events

A future web UI should likely do the same.

That implies a clean split:

- runtime owns execution truth and document truth
- clients own local view state and rendering state

Examples of client-side state include:

- expanded or collapsed cards
- focus and selection
- theme choices
- local input/editor state
- viewport and scroll state

Those do not belong in the procedure/runtime document model.

## Scoped subtree authority

The question “should procedures be allowed to emit arbitrary structured frontend events?” becomes much easier once the execution tree and turn document models exist.

A procedure is always executed within the scope of:

- a session
- a turn
- a specific procedure node in the execution tree

So a procedure should not have authority to mutate the whole session document or emit arbitrary session-wide frontend events.

Instead, a procedure should only be able to author semantic content within the execution/document subtree that it owns.

That means:

- a procedure may update its own live status
- a procedure may append cards, artifacts, and telemetry to its own subtree
- a procedure may create child subtrees by calling `callProcedure()` or `callAgent()`
- a procedure may not forge or mutate sibling or parent-owned content
- a procedure may not synthesize arbitrary top-level runtime events

This gives nanoboss a clean capability model:

- the runtime owns the global execution tree and turn document
- each procedure receives scoped authority over its own node and descendants
- child subtrees are created only through runtime-controlled operations
- renderers consume the projected document rather than raw procedure-emitted frontend envelopes

This also creates a useful distinction between two kinds of information:

### Procedure-authored content

Content intentionally produced by the procedure inside its own subtree, for example:

- status text and structured status fields
- proposal cards
- summary cards
- notifications
- artifacts
- procedure-authored telemetry annotations

### Runtime-observed content

Content created by the runtime because it observed execution, for example:

- procedure start/end records
- child agent and tool nodes
- timing traces
- token snapshots
- ownership edges
- dispatch lifecycle facts

A procedure may influence runtime-observed content only indirectly by invoking runtime operations. It should not be able to spoof those facts directly.

### Mutation rules

The append-vs-mutate policy should be explicit.

Recommendation:

- status is mutable
- cards are mostly append-only
- telemetry is append-only or monotonic updates
- runtime-observed execution facts are immutable once recorded

That preserves a trustworthy history while still allowing live status updates.

### Capability table

| Kind | Created by | Procedure may create? | Procedure may update? | Notes |
| --- | --- | --- | --- | --- |
| Current procedure status | Procedure | Yes | Yes | Mutable live state for the current procedure node |
| Procedure-authored card | Procedure | Yes | Rarely, prefer no | Prefer append-only after emission |
| Procedure-authored artifact link | Procedure | Yes | Limited | Can attach files/refs owned by subtree |
| Procedure-authored telemetry annotation | Procedure | Yes | Monotonic only | For semantic annotations, not forged execution facts |
| Child procedure node | Runtime via `callProcedure()` | Indirectly | No | Procedure requests creation; runtime records it |
| Child agent node | Runtime via `callAgent()` | Indirectly | No | Procedure requests execution; runtime records it |
| Child tool-call node | Runtime | No | No | Observed execution fact |
| Token snapshot / token totals | Runtime | No | Runtime only | Initially measured at `callAgent()` boundaries |
| Timing trace entries | Runtime | No | No | Observed execution fact |
| Parent or sibling subtree content | Other procedure / runtime | No | No | Outside procedure authority |
| Session-global chrome | Client / runtime | No | No | Busy state, queued prompts, key hints, etc. |
| Top-level run lifecycle event | Runtime | No | No | Start, pause, complete, fail, cancel |

## Recommended migration phases

### Phase 1: Document the runtime concepts explicitly

Before changing code, formalize the conceptual model:

- procedure
- cell
- ref
- run
- bridge
- dispatch
- UI event

This proposal is part of that phase.

### Phase 2: Extract a runtime API interface behind MCP

Create an internal service interface that represents:

- procedure list / get / dispatch
- session history inspection
- ref read / stat / write
- schema inspection

Then re-implement the current MCP layer as an adapter over that interface.

Success criterion:

- MCP no longer owns the primary implementation

### Phase 3: Introduce a JSON CLI adapter

Expose the same runtime API through a machine-readable CLI.

Success criterion:

- a human or agent can perform the same session/procedure operations without MCP registration

### Phase 4: Introduce `ctx.ui`

Add structured procedure-side UI APIs while keeping `print()`.

Minimum first step:

- `text`
- `info`
- `warning`
- `error`
- `status`
- `card`

This would eliminate the current accidental API where `Info:` text gets special treatment.

The first implementation should explicitly support:

- live procedure status with active procedure name
- Markdown-rendered cards for proposals, summaries, and checkpoints

The first telemetry implementation should explicitly support:

- token accounting at `callAgent()` boundaries
- rollups from agent calls into procedures and top-level runs
- optional UI rendering of that metadata without making the UI define the accounting model

### Phase 5: Introduce `ctx.state`

Refactor `ctx.session` and `ctx.refs` into a clearer runtime-state namespace.

Add at least:

- `runs.latest(...)`
- `runs.parent(...)`
- `runs.children(...)`

Those are the most obvious ergonomic gaps relative to current store primitives.

### Phase 6: Introduce `ctx.agent` and the nanoboss bridge

Keep current `callAgent()` behavior, but add a clearer capability-oriented surface.

Success criterion:

- internal prompts can say “use nanoboss runtime tools” without hardcoding MCP handle discovery steps

### Phase 6.5: Add execution-tree telemetry and history annotations

Before calling the UI work done, add first-class runtime accounting for:

- token usage per nested `callAgent()` call
- rollups per procedure subtree
- rollups per top-level run
- optional session-level rollups

Also annotate replay/history with procedure ownership for rendered tool-call events.

Success criteria:

- the UI can show which active procedure a status view belongs to
- a completed complex procedure can show total token consumption for the whole run
- rendered tool-call history can be attributed back to the owning procedure subtree
- the initial telemetry model does not over-promise finer granularity than the runtime can currently measure

### Phase 7: Migrate internal dispatch off MCP-specific prompt wording

The prompt in [src/core/service.ts](/Users/jflam/agentboss/workspaces/nanoboss/src/core/service.ts#L1243) is the clearest place to pay down the current design debt.

Replace:

- instructions about global MCP handles and `procedure_dispatch_start` / `wait`

With:

- instructions about using the nanoboss bridge

If MCP remains the transport behind the bridge for some providers, that becomes hidden implementation detail.

## Open questions

### 1. Should procedures be allowed to emit arbitrary structured frontend events?

No, not as arbitrary global frontend events.

Recommendation:

- expose a curated procedure-scoped authoring API
- do not expose raw frontend event envelopes to procedures
- scope procedure authority to its own execution/document subtree

This preserves runtime control, avoids UI coupling at the procedure layer, and prevents procedures from spoofing execution facts outside their owned subtree.

It also preserves renderer independence across pi-tui and future web frontends.

### 1.25. Should the UI API be just a set of primitives?

No.

That is useful but insufficient.

Recommendation:

- define a logical turn document model
- treat UI operations as scoped mutations or appends against that model
- preserve a clear distinction between execution ownership and document projection

### 1.5. Should cards be part of procedure output or only frontend composition?

They should be a first-class procedure/runtime concept.

Reason:

- procedures like `simplify2` have outputs that are neither mere status text nor just final `display`
- Markdown proposals, reports, and checkpoints are part of the workflow itself
- if cards are only a frontend composition trick, the durable runtime model stays underspecified

Recommendation:

- make cards part of the curated `ctx.ui` surface
- store enough metadata to replay them durably

### 2. How much of the cell/ref model should be exposed directly?

The cell/ref model is a good durable substrate and should remain foundational.

Recommendation:

- keep cells/refs as the low-level truth
- add higher-level run/query helpers on top
- do not force authors and agents to think in raw graph traversal for common cases

### 3. Should agent bridge capabilities be static or per-call scoped?

Per-call scoped.

Recommendation:

- the default should remain conservative
- a procedure should opt into nanoboss bridge capabilities for a given agent call

This fits the deterministic-workflow model better than making every agent implicitly omniscient about the runtime.

### 3.5. What granularity should token accounting target initially?

Recommendation:

- start with `callAgent()` boundaries
- store snapshots and totals on execution nodes
- compute subtree rollups from those nodes
- only add finer attribution later when ACP or provider telemetry makes it reliable

This keeps the model useful without pretending nanoboss has exact per-tool token deltas today.

### 4. Should async procedure dispatch be part of the procedure API or only the runtime API?

It should be part of the runtime API and then surfaced into procedures through a thin procedure-facing layer.

Reason:

- dispatch is a runtime orchestration concept, not just a procedure-authoring concern

## Success criteria

This proposal is successful if nanoboss ends up with:

- a runtime-first conceptual API independent of transport
- a clearer procedure authoring API with explicit `agent`, `state`, and `ui` domains
- a better fit for session history and runtime-state querying
- a structured way for agents to call back into nanoboss
- a layered UI model separating CLI chrome, live procedure status, durable cards, and telemetry
- a clear separation between execution tree ownership and turn-document rendering
- Markdown-rendered cards for proposal/review style workflow outputs
- explicit active-procedure identity in live status views
- token accounting that initially rolls up from `callAgent()` boundaries over the execution tree
- session history that can attribute rendered tool-call UI back to owning procedures
- a renderer-neutral UI/event model consumable by both pi-tui and future web frontends
- an architecture that assumes stateful clients while keeping runtime and view concerns separate
- MCP preserved as an adapter rather than the primary internal abstraction
- a viable JSON CLI fallback for agent/runtime interaction when MCP is painful

## Bottom line

The current procedure API is good at deterministic orchestration, but incomplete in two important ways:

- it does not expose the runtime state model ergonomically enough
- it does not expose rich procedure-to-UI and agent-to-runtime communication as first-class concepts

The right next move is not to go deeper into MCP as the core abstraction.

The right next move is to define a clean runtime API, then let:

- procedures use it directly
- agents access it through a controlled nanoboss bridge
- MCP and CLI both act as adapters over it

That keeps nanoboss grounded in its actual runtime model instead of letting transport details define the architecture.
