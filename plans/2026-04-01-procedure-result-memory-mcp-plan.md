# 2026-04-01 Plan: Procedure Result Memory Cards + Session MCP Bridge

## Status

Proposed, not yet implemented.

This plan addresses the gap where a top-level procedure result is persisted in `SessionStore` but is not naturally available to later conversational `/default` turns.

Related plans:

- `plans/2026-03-31-kernel-handles-spec.md`
- `plans/2026-03-31-session-mcp-spec.md`
- `plans/2026-03-31-multi-turn-session-history-and-result-context-plan.md`

---

## Problem

`nanoboss` currently has two memory domains:

1. **native downstream ACP conversation state**
   - used by `DefaultConversationSession`
   - this is what makes ordinary `/default` follow-ups like `what is 3+4` → `add 3` work
2. **outer semantic session state in `SessionStore`**
   - stores top-level procedure inputs/outputs, summaries, refs, and nested cells
   - this is where prior procedure results live

The bug is that these two domains are not bridged.

Example:

```text
/second-opinion review the code
<long rendered procedure output>
what is the most important element of code review?
```

The `/second-opinion` result is stored in session history, but the next `/default` turn does not automatically know that result exists. The downstream agent sees only its own native conversation state, not the prior top-level procedure result.

---

## Goal

Preserve the outer agentic loop without dumping large procedure outputs into conversational context.

Desired behavior:

1. when a procedure finishes, `nanoboss` persists a compact **memory card** describing the result
2. later `/default` turns receive a bounded memory update about newly completed procedure results
3. if the user asks for exact details, the downstream agent can use **nanoboss MCP tools** to inspect stored cells, refs, displays, and schema/shape information by reference

This should give the model:

- enough semantic context to answer simple follow-ups naturally
- a tool-based path to retrieve exact stored data when needed
- no giant transcript stuffing and no fake reconstruction of whole procedure output

---

## Hard requirements and decisions

### 1. MCP must live inside the `nanoboss` binary

The MCP server must be implemented as part of the same executable as the rest of `nanoboss`.

Allowed:

- an in-process loopback HTTP MCP server started by the running `nanoboss` process
- a stdio MCP mode exposed as a `nanoboss` subcommand
- provider-specific config that always points back to the same `nanoboss` executable

Not allowed:

- a separate helper package
- a separate companion daemon just for session memory
- a standalone MCP proxy binary distinct from `nanoboss`

### 2. `/default` continuity remains native-first

This feature is specifically the bridge for **non-default procedure results**.

It should **not** replace native `/default` chat continuity with synthetic memory-card replay.

- ordinary `/default` follow-ups continue to rely on native ACP session continuity
- top-level `/default` turns are also persisted in `SessionStore`, but that is not the primary continuation mechanism for ordinary chat follow-ups

### 3. Memory applies uniformly in storage, selectively in conversation

Decision:

- store `memory` on any `CellRecord.output` for uniformity
- only generate/use memory cards for **top-level non-default procedure cells** initially

Do not expose nested `callAgent` cells or internal child procedure noise as conversational memory.

### 4. Full display is retrievable, not injected

Decision:

- full `display` should be retrievable by tool
- it should not be injected into prompt context by default

### 5. Schema/shape should support duck-typed discovery

Decision:

- the primary goal is to give the model enough structural information to know what to ask for next
- include only a compact inferred shape or compact schema summary in the memory preamble
- do not dump a large JSON schema block unless it is tiny and clearly useful
- provide a tool-based path to query schema/shape on demand

The important idea here is **duck typing**, not nominal typing:

- if a stored result has fields like `subject`, `critique`, and `verdict`, the model should be able to recognize it as “second-opinion-like”
- if a stored result has fields like `command`, `errors`, and `recommendations`, the model should be able to recognize it as “linter-like”

So schema/shape metadata exists primarily for affordance discovery: telling the model what fields, refs, and nested values are available.

### 6. Sync should be lazy and delta-based

Decision:

- only unsynced top-level non-default completions since the last `/default` sync are surfaced
- keep the preamble bounded and delta-based

This preserves model context and avoids repeated re-injection.

---

## Core design

## 1. Add a first-class procedure memory card

Current fields are not enough on their own:

- `summary` is often too short
- `display` is often too large
- `data` is machine-oriented and may contain refs rather than directly useful prose

Extend procedure results conceptually to:

```ts
interface ProcedureResult<T extends KernelValue = KernelValue> {
  data?: T;
  display?: string;
  summary?: string;
  memory?: string;
  explicitDataSchema?: object;
}
```

Meaning:

- `memory`: compact follow-up-oriented prose suitable for later conversational grounding
- `explicitDataSchema`: optional runtime schema for `output.data`

`memory` should answer:

- what happened?
- what matters most?
- what exact stored result exists if the agent wants more?

Example for `/second-opinion`:

- `summary`: `second-opinion: review the code (mixed)`
- `memory`: `Second opinion judged the review mixed. Main issues were missing edge cases, weak evidence for one claim, and unclear prioritization. The most important issue was the missing edge-case analysis.`

---

## 2. Persist memory metadata in `SessionStore`

Extend `CellRecord.output` conceptually to:

```ts
output: {
  data?: KernelValue;
  display?: string;
  stream?: string;
  summary?: string;
  memory?: string;
  explicitDataSchema?: object;
}
```

Also extend `CellSummary` or add a new summary/materializer shape so prompt sync and discovery can surface:

- summary
- memory
- refs
- compact `dataShape` metadata
- optional `explicitDataSchema` metadata when present

Fallback rule for missing `memory`:

1. prefer `summary`
2. otherwise synthesize a bounded summary from `display`
3. otherwise omit memory-card prose

---

## 3. Inject memory lazily, not as fake chat turns

Do **not** write hidden synthetic turns into the native ACP session when a procedure completes.

Instead:

- procedure completion stores a durable memory card in `SessionStore`
- session runtime tracks which cards have already been exposed to the default chat loop
- the next `/default` turn prepends a bounded **memory update preamble** for any unsynced cards

Semantically, the next `/default` submission should look like:

```text
[memory update preamble]

[current user prompt]
```

This means the memory update is prepended to the prompt payload for that `/default` request, not written earlier as a fake hidden chat turn.

Example preamble:

```text
Nanoboss session memory update:

- procedure: /second-opinion
- input: review the code
- summary: second-opinion judged the review mixed
- memory: Main issues were missing edge cases, weak evidence, and unclear prioritization. The most important issue was the missing edge-case analysis.
- result_ref: session=<sessionId> cell=<cellId> path=output.data
- display_ref: session=<sessionId> cell=<cellId> path=output.display
- data_shape: { subject: string, answer: ValueRef, critique: ValueRef, verdict: "sound" | "mixed" | "flawed" }

If the user asks for exact details, use the nanoboss MCP tools to inspect the stored result or follow refs.
```

This is a small index card, not a full dump.

---

## 4. Add a read-only session MCP server

The downstream agent needs a principled way to inspect stored results on demand.

Today both `src/default-session.ts` and `src/call-agent.ts` create ACP sessions with:

```ts
mcpServers: []
```

So the downstream agent currently has no direct tool access to nanoboss session memory.

Add a small **nanoboss MCP server** that exposes read-only tools against the current `SessionStore`.

Minimum useful v1 surface:

### Discovery

- `session_last()`
- `session_recent(procedure?: string, limit?: number)`
- `cell_get(cellRef)`

### Refs

- `ref_read(valueRef)`
- `ref_stat(valueRef)`
- `ref_write_to_file(valueRef, path)`

### Schema / shape

- `get_schema(cellRef | valueRef)` or equivalent support in `cell_get` / `ref_stat`
- later, optionally `find_cells_by_shape(...)` for duck-typed discovery across prior turns

The primary schema use case is structural discovery over the concrete stored `KernelValue`, not nominal type recovery.

Constraints:

- read-only by default
- scoped to the current `nanoboss` session
- small and predictable tool surface
- no mutation of prior cell history

---

## 5. Split prompt grounding from exact retrieval

A ref by itself is not enough for the downstream model unless `nanoboss` resolves it or exposes it through tools.

This is fundamentally a **duck-typing / discoverability** problem: the model needs enough structural information to know what to ask for next.

So the bridge should split responsibilities deliberately:

### Prompt layer

Inject only:

- summary
- memory
- stable refs
- compact inferred or explicit data shape
- clear instruction that exact details are retrievable by tool

### MCP layer

Provide:

- exact stored cell data
- exact stored display/stream content
- nested ref traversal
- file/export operations
- schema/shape lookup

This gives the model a bounded index plus exact retrieval when needed.

---

## 6. Runtime shape strategy: infer concrete `KernelValue` shape first

The primary metadata here is the **concrete derived shape of the stored `KernelValue`**.

Call that inferred structure `dataShape`.

That shape tells the model what is available:

- which fields exist
- which fields are refs
- what nested objects/arrays exist
- which scalars or enum-like values are present

This is primarily for duck-typed discovery, not for recovering an original TypeScript type name.

So schema support should be two-tiered:

### Phase 1

Infer lightweight shape directly from the stored value:

- scalar type
- object keys
- array/object nesting
- enum-like values when obvious from current value
- ref positions such as `ValueRef` / `CellRef`

This is enough to help the model plan follow-up retrieval.

### Phase 2

Allow procedures to attach true runtime `explicitDataSchema` when they have one.

That is additive. The inferred concrete `dataShape` remains the primary baseline because it always exists for stored `KernelValue` data.

---

## Agentboss MCP research: what we should copy

I reviewed the existing `agentboss` MCP integration for the same four agent families `nanoboss` supports:

- Claude Code
- Codex
- Gemini CLI
- Copilot

Relevant files:

- `/Users/jflam/agentboss/workspaces/agentboss/crates/agentboss-cli/src/cmd_mcp.rs`
- `/Users/jflam/agentboss/workspaces/agentboss/crates/agentboss-executor/src/runtime/mcp_setup.rs`
- `/Users/jflam/agentboss/workspaces/agentboss/crates/agentboss-executor/src/runtime/agent_launch.rs`

### Main findings

1. `agentboss` has two MCP layers:
   - **global native-agent registration** (`agentboss mcp register`)
   - **per-session ACP injection** when spawning agents directly
2. `nanoboss` is much closer to the second case because it launches ACP agents directly in `src/default-session.ts` and `src/call-agent.ts`
3. MCP attachment is **provider-specific**, not universal

### Provider strategy table derived from `agentboss`

| Provider | `agentboss` pattern | `nanoboss` implication |
|---|---|---|
| Claude Code | ACP `mcpServers` with loopback HTTP | use in-process loopback HTTP MCP hosted by live `nanoboss` |
| Codex | ACP `mcpServers` with loopback HTTP | same as Claude |
| Gemini CLI | stdio MCP injection even under ACP | support stdio MCP mode via the same `nanoboss` binary |
| Copilot | `--additional-mcp-config` or global registration | add a Copilot-specific attachment path, still targeting the same `nanoboss` binary |

### Additional findings worth copying

- global registration is also provider-specific:
  - Claude: native `claude mcp add ... -- <binary> mcp proxy`
  - Codex: native `codex mcp add ... -- <binary> mcp proxy`
  - Gemini: write `~/.gemini/settings.json`
  - Copilot: write `~/.copilot/mcp-config.json`
- `agentboss` passes session/execution identity to its MCP layer through env

For `nanoboss`, a similar context payload will probably be needed, e.g.:

- `NANO_AGENTBOSS_SESSION_ID`
- maybe current cwd / workspace root
- maybe provider identity
- maybe read-only vs write-enabled mode

### Design consequence

Do **not** assume all four providers can consume the session MCP server through the same ACP config field.

Instead, Phase 4 should use **provider-aware MCP attachment strategies**, while always resolving back to the same `nanoboss` executable.

---

## Implementation phases

## Phase 0: align with existing cell/ref model

Treat this as an extension of the existing kernel/ref model, not a competing model.

Keep these invariants:

- `SessionStore` is the durable source of truth
- `CellRef` / `ValueRef` remain the canonical identity mechanism
- large results stay out of generic prompt context unless explicitly fetched

## Phase 1: extend types and persistence

Update:

- `src/types.ts`
- `src/session-store.ts`

Changes:

- add `memory?: string` to `ProcedureResult`
- add `explicitDataSchema?: object` to `ProcedureResult`
- persist both on `CellRecord.output`
- surface `dataShape` and optional `explicitDataSchema` through `CellSummary` or a new summary/materializer shape
- preserve backward compatibility when older cells lack these fields

## Phase 2: build memory-card materialization

Add a helper, e.g. `src/memory-cards.ts`, that:

- inspects current session history
- selects only top-level non-default completed procedure cells
- skips nested `callAgent` cells and internal child procedure noise
- computes a bounded set of cards to expose
- infers `dataShape` from `output.data`
- includes enough structural information for duck-typed discovery without dumping full data
- includes `explicitDataSchema` only when a procedure provided one

Suggested shape:

```ts
interface ProcedureMemoryCard {
  cell: CellRef;
  procedure: string;
  input: string;
  summary?: string;
  memory?: string;
  dataRef?: ValueRef;
  displayRef?: ValueRef;
  dataShape?: object;
  explicitDataSchema?: object;
  createdAt: string;
}
```

## Phase 3: track sync state for `/default`

Extend `SessionState` in `NanoAgentBossService` with something like:

```ts
syncedProcedureMemoryCellIds: Set<string>
```

Behavior:

- top-level non-default procedure completions become eligible for sync
- next `/default` turn gathers unsynced cards
- `nanoboss` renders one bounded memory-update preamble
- cards are marked synced only after prompt submission succeeds

This sync state belongs to runtime session state, not `SessionStore` durable history.

## Phase 4: build the session MCP server and attachment layer

Possible files:

- `src/session-mcp-server.ts`
- `src/mcp/session-tools.ts`
- `src/mcp-entrypoint.ts`
- `src/mcp-attachment.ts`

Responsibilities:

- expose session discovery, ref-reading, and schema/shape tools
- resolve only within the current `sessionId`
- serialize safely and provide previews for large values
- support `get_schema(...)` over stored cells/refs
- later optionally support shape-based discovery such as `find_cells_by_shape(...)`
- support either:
  - in-process loopback HTTP MCP owned by the current `nanoboss` process, or
  - stdio MCP mode exposed by the same `nanoboss` binary
- attach the right transport/config per downstream provider
- keep provider quirks out of `default-session.ts` and `call-agent.ts`

Likely initial provider mapping:

- Claude: ACP `mcpServers` + loopback HTTP
- Codex: ACP `mcpServers` + loopback HTTP
- Gemini: stdio MCP via `nanoboss <mcp-subcommand>`
- Copilot: additional MCP config or global registration path, still targeting `nanoboss`

## Phase 5: update `/default` continuation

Update the dedicated default-session path so native ACP continuity remains primary, but newly completed procedure results are surfaced as bounded session-memory updates.

Flow:

1. user sends a plain `/default` turn
2. `nanoboss` gathers unsynced procedure memory cards
3. `nanoboss` renders a compact memory update preamble
4. `nanoboss` submits preamble + current user prompt
5. downstream agent answers directly or uses MCP tools for exact retrieval
6. synced cards are marked as exposed

Non-goal:

- do not rebuild the entire session transcript here
- this is incremental procedure-result bridging, not generic history reconstruction

## Phase 6: update selected procedures

Start with procedures likely to be referenced conversationally.

Initial candidate:

- `commands/second-opinion.ts`

Potential later candidates:

- `linter`
- `create`
- other review/synthesis procedures

Each should provide:

- short `summary`
- better follow-up-oriented `memory`
- small manifest-style `data`
- refs for exact retrieval

---

## Tests

### Unit tests

#### `SessionStore`

- persists `memory` and optional `explicitDataSchema`
- loads old cells without them
- surfaces them through summary/materializer helpers

#### memory-card materializer

- selects only top-level non-default procedure cells
- skips nested `callAgent` cells
- infers data shape from stored `output.data`
- bounds the number/size of rendered cards

#### sync logic

- unsynced cards are included once
- already-synced cards are not re-injected
- cards are only marked synced after prompt submission succeeds

#### MCP tools

- `session_recent` returns expected summaries
- `cell_get` returns exact cell data
- `ref_read` follows nested refs correctly
- `ref_stat` returns preview/size/type
- `ref_write_to_file` materializes referenced values correctly
- `get_schema(...)` returns compact schema/shape information derived from stored `KernelValue` data
- if implemented, shape-based discovery returns matching cell ids for duck-typed queries

### Integration tests

#### Case 1: follow-up after `/second-opinion`

- run `/second-opinion ...`
- then run a plain follow-up question
- assert the downstream prompt contains the memory update preamble, not the full display dump
- assert the agent can answer coherently from the memory card alone in a deterministic mock setup

#### Case 2: follow-up requiring exact retrieval

- run a procedure that returns a manifest with nested refs
- then ask for an exact sub-result
- assert the downstream agent uses the session MCP tools to fetch the referenced data

#### Case 3: multiple procedure results before next `/default`

- run two non-default procedures
- then a plain follow-up
- assert both appear in a bounded memory update block
- assert they are not re-injected on a later plain follow-up unless new procedure results were added

---

## Success criteria

This plan is successful if:

1. after `/second-opinion ...`, a later plain follow-up can refer to that result coherently
2. the downstream prompt contains a compact memory card, not a full procedure output dump
3. exact stored result retrieval works by reference through MCP tools
4. native `/default` conversation remains the primary continuity mechanism
5. nested internal procedure/agent noise does not leak into the conversational memory layer
6. existing typed composition through `CellRef` and `ValueRef` remains intact

---

## Recommended first slice

Implement the smallest end-to-end vertical path:

1. add `memory?: string` to `ProcedureResult`
2. persist it in `SessionStore`
3. create a minimal memory-card materializer for top-level non-default cells
4. create a minimal read-only session MCP server **inside the `nanoboss` binary** with:
   - `session_recent`
   - `cell_get`
   - `ref_read`
   - `ref_stat`
   - `get_schema(...)` or equivalent compact schema/shape lookup over stored `KernelValue` data
5. add provider-aware MCP attachment helpers that always target the same `nanoboss` executable
6. wire the MCP server into `/default` ACP sessions
7. prepend unsynced memory cards to the next `/default` prompt
8. update `/second-opinion` to emit a strong `memory` field
9. add one deterministic follow-up test and one MCP retrieval test

That slice proves the architecture before broadening it to more procedures or richer tool surfaces.
