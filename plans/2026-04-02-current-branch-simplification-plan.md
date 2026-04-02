# 2026-04-02 Current Branch Simplification Plan

## Scope reviewed

Primary focus:

- current branch `master`
- latest commit `90eaf44` — **Add structural session MCP helpers**

Files reviewed closely:

- `src/session-mcp.ts`
- `src/session-mcp-http.ts`
- `src/session-store.ts`
- `src/memory-cards.ts`
- `src/context.ts`
- `src/call-agent.ts`
- `src/default-session.ts`
- `src/types.ts`
- `src/create.ts`
- `commands/linter.ts`

---

## Executive summary

The branch is moving in the right direction: the new structural session helpers are a real improvement over pure recency scans.

But the latest commit also makes a pre-existing problem more visible:

**there are now too many overlapping ways to ask for similar things, and several of those ways are implemented in parallel rather than derived from one canonical path.**

That creates exactly the kind of maintenance hazard you called out:

- more than one place to patch when behavior changes
- more than one mental model for agents and procedure authors
- more than one transport/dispatcher path for the same feature
- compatibility aliases that are still first-class in prompts and docs

My recommendation is to treat this as a **surface-area reduction** pass, not a feature pass.

Because there are currently zero users, the plan should prefer deletion over compatibility.

---

## Core simplification principles

1. **One concept, one canonical path.**
   Redundant aliases should be deleted, not preserved.

2. **Transport should be thin.**
   HTTP vs stdio should not duplicate MCP semantics.

3. **Session traversal should have one vocabulary.**
   If models use structural helpers, internal code and procedure-author docs should use the same structure.

4. **Persistence format can stay stable while APIs get smaller.**
   We do not need a storage rewrite to simplify the public surface.

5. **Prefer declarative registries over parallel switch statements.**
   If a tool exists, its schema, parser, description, and implementation should live together.

---

## Findings

### 1. The new session MCP surface introduces overlapping pathways for the same query

Relevant code:

- `src/session-mcp.ts:307-407`
- `src/session-mcp.ts:460-509`
- `src/session-store.ts:203-345`
- `src/memory-cards.ts:135-142`

Examples of overlap:

- `session_last()` vs `session_recent({ limit: 1 })`
- `cell_parent(cell)` vs `cell_ancestors(cell, { limit: 1 })[0]`
- `cell_children(cell, ...)` vs `cell_descendants(cell, { maxDepth: 1, ... })`
- `session_recent(...)` vs `top_level_runs(...)` for discovery of prior user-visible runs

This is the most important simplification issue in the latest commit.

The new helpers are individually understandable, but together they create a menu of near-equivalents. That is good for convenience and bad for reliability.

### Recommendation

Pick a canonical structural vocabulary and delete the redundant helpers outright.

My preferred end state:

- keep `session_recent`
- keep `top_level_runs`
- keep `cell_ancestors`
- keep `cell_descendants`
- keep `cell_get`
- keep `ref_read`
- keep `ref_stat`
- keep `ref_write_to_file`
- keep `get_schema`

Delete:

- `session_last` — use `session_recent({ limit: 1 })`
- `cell_parent` — use `cell_ancestors(..., { limit: 1 })`
- `cell_children` — use `cell_descendants(..., { maxDepth: 1 })`

Most importantly: **teach only the surviving primitives in prompts, docs, tests, and examples**.

#### Target minimal retrieval surface

For the specific job of retrieving information from prior conversation turns, runs, and cells, the target minimal API should be:

- `top_level_runs(...)`
- `cell_ancestors(...)`
- `cell_descendants(...)`
- `cell_get(...)`
- `ref_read(...)`

Why this is enough:

- `top_level_runs(...)` finds prior chat-visible turns
- `cell_descendants(...)` explores nested work under a run
- `cell_ancestors(...)` walks back up from a nested cell when needed
- `cell_get(...)` gives exact cell metadata and refs
- `ref_read(...)` gives the exact stored value

This is the smallest surface that still reads naturally as a retrieval recipe.

Non-core helpers may still exist if they prove useful, but they should not be taught as the main path for retrieval:

- `session_recent(...)` — global recency scan, not the canonical run/cell retrieval path
- `get_schema(...)` — inspection aid, not core retrieval
- `ref_stat(...)` — preview aid, not core retrieval
- `ref_write_to_file(...)` — export helper, not retrieval

---

### 2. MCP behavior is duplicated across stdio and HTTP transports

Relevant code:

- `src/session-mcp.ts:127-279`
- `src/session-mcp-http.ts:67-196`
- `src/mcp-attachment.ts:14-24`

Problems:

- both files implement MCP method dispatch separately
- both parse `initialize`, `ping`, `tools/list`, and `tools/call`
- both reimplement `asObject`, `asOptionalObject`, and `asString`
- protocol/version metadata already diverges:
  - stdio: `2024-11-05` and `getBuildLabel()` in `src/session-mcp.ts:13`, `234-245`
  - HTTP: `2025-11-25` and hardcoded `0.1.0` in `src/session-mcp-http.ts:24`, `129-140`
- transport selection is still provider-split in `src/mcp-attachment.ts`

Additional research result:

I inspected `~/src/copilot-agent-runtime` and found that the Copilot ACP path now supports HTTP MCP servers.

Concrete evidence:

- `src/cli/acp/server.ts` implements `convertAcpMcpServer(...)` with explicit handling for `type: "http"`
- the ACP `newSession(...)` and `loadSession(...)` paths iterate `params.mcpServers` and start those servers
- `src/mcp-client/types.ts` defines remote MCP configs with `type: "http" | "sse"`
- `src/mcp-client/factories/transport-factory.ts` constructs `StreamableHTTPClientTransport` for HTTP MCP servers
- `test/cli/acp/server.test.ts` includes direct tests for ACP HTTP MCP server conversion

That means the current split in nanoboss is no longer justified by Copilot transport limitations.

This is a classic drift trap.

### Recommendation

Standardize nanoboss on **HTTP-only MCP attachment** and delete stdio session MCP transport.

Concretely:

- make `src/mcp-attachment.ts` always return `ensureSessionMcpHttpServer(...)`
- delete `buildStdioSessionMcpServer(...)`
- delete `runSessionMcpServerCommand()` and `SessionMcpStdioServer` from `src/session-mcp.ts`
- keep one shared MCP request/dispatch implementation used by the HTTP server

Also centralize:

- protocol version
- server info/version
- request arg parsing helpers

This is higher-value than merely sharing logic between two transports, because there is now evidence that nanoboss can actually collapse to one transport instead of preserving both.

---

### 3. Session MCP tool definitions are split across parallel registries

Relevant code:

- `src/session-mcp.ts:281-457`
- `src/session-mcp.ts:460-509`

Today, adding a tool requires updating at least:

- `SessionMcpApi`
- `listSessionMcpTools()`
- `callSessionMcpTool(...)`
- often also transport dispatch callers

That is too many patch points for one feature.

### Recommendation

Replace the manual array + switch with a single declarative tool table, for example conceptually:

- name
- description
- input schema
- parse args
- call implementation

Then derive both:

- `tools/list`
- `tools/call`

from the same source of truth.

This will make future simplification work much safer.

---

### 4. Internal code still uses old flat scans even after structural helpers landed

Relevant code:

- `src/memory-cards.ts:23-69`
- `src/memory-cards.ts:123-129`
- `src/session-store.ts:207-233`
- `src/session-store.ts:316-345`

`collectUnsyncedProcedureMemoryCards(...)` and `hasTopLevelNonDefaultProcedureHistory(...)` still do:

- `store.recent({ limit: 200 })`
- re-read every cell
- manually filter for `record.meta.kind === "top_level"`

That duplicates the intent of `topLevelRuns()` and preserves two internal patterns for the same concept.

### Recommendation

Refactor internal top-level discovery to use the structural index directly.

Example desired rule:

- if the question is about top-level user-visible runs, use `topLevelRuns()` everywhere internally too
- reserve `recent()` for truly global recency scans

This is a very good candidate for an early cleanup because it removes confusion immediately without changing storage.

---

### 5. Procedure-facing session APIs lag behind the new structural model

Relevant code:

- `src/types.ts:88-91`
- `src/context.ts:454-469`
- `src/create.ts:52-60`

Current state:

- `ctx.session` only exposes `last()` and `recent(...)`
- the `/create` prompt teaches only `ctx.session.last()` and `ctx.session.recent(...)`
- models invoked through MCP are being taught a richer structural vocabulary than procedure authors get through `CommandContext`

This creates two discovery systems:

- structural MCP for downstream agents
- flat session API for procedures

Even if that split was intentional at first, it now increases cognitive overhead.

### Recommendation

With zero compatibility constraints, I would make the decision now instead of preserving two options:

- expose the same structural traversal vocabulary on `ctx.session`
- remove `ctx.session.last()`
- keep `ctx.session.recent(...)` only for true global-recency queries
- add structural methods like `topLevelRuns(...)`, `ancestors(...)`, `descendants(...)`, and `get(...)` so procedure authors and MCP users learn the same model

This reduces the number of mental models in the codebase and removes flat-only convenience APIs that are no longer pulling their weight.

---

### 6. Agent invocation/session lifecycle logic is duplicated in two separate implementations

Relevant code:

- `src/call-agent.ts:28-59`, `389-501`
- `src/default-session.ts:63-127`, `142-199`, `206-251`, `321-420`
- `src/context.ts:104-233`, `307-413`, `526-546`

There are currently multiple pathways for “call an agent and record the result”:

- standalone `callAgent(...)`
- `CommandContextImpl.callAgent(...)`
- `CommandContextImpl.continueDefaultSession(...)`
- `DefaultConversationSession` / `PersistentAcpSession`

Some duplication is justified because one path is one-shot and one path is persistent, but too much behavior is repeated in parallel:

- ACP child-process setup
- transcript path creation and transcript append logic
- permission auto-approval logic
- MCP server attachment
- session config application (`model`, `reasoningEffort`)
- streamed text collection
- final result summarization
- tool-call start/end bookkeeping in `context.ts`

This is another major “patch in multiple places” hotspot.

### Recommendation

Split this into layers:

1. **shared ACP connection/session runtime**
   - spawn child
   - initialize ACP connection
   - transcript logging
   - permission policy
   - apply session config

2. **execution mode**
   - one-shot prompt session
   - persistent reusable session

3. **nanoboss bookkeeping wrapper**
   - start cell
   - forward updates
   - finalize cell
   - logger events
   - summary extraction

That gives one place to change transport behavior and one place to change nanoboss bookkeeping.

---

### 7. The session store has several similar traversal loops that can drift

Relevant code:

- `src/session-store.ts:207-233`
- `src/session-store.ts:241-245`
- `src/session-store.ts:247-262`
- `src/session-store.ts:264-314`
- `src/session-store.ts:316-345`
- `src/session-store.ts:398-418`

The current store is still readable, but it now has several slightly different “iterate cell ids + filter + limit + summarize” paths.

This is not the biggest problem, but the latest commit increased the chance of semantic drift.

### Recommendation

Do a light consolidation, not an abstraction binge.

Good candidates:

- one internal helper for ordered iteration with filtering + limit
- one canonical filter matcher
- implement surviving public helpers in terms of the smallest useful set of internal traversal primitives

Avoid over-generalizing into a mini query language inside `SessionStore` unless the public API is being reduced at the same time.

---

### 8. There is still avoidable schema/validator boilerplate

Relevant code:

- `src/create.ts:16-34`
- `commands/linter.ts:32-86`
- `src/types.ts:117-138`

The repo already has a preferred `typia` + `jsonType(...)` pattern, but some commands still hand-roll `TypeDescriptor` schema/validation.

This is not the biggest simplification target, but it does add noisy code that hides intent.

### Recommendation

Convert hand-written descriptors to the standard `jsonType(...)` pattern where possible.

This is a medium-priority readability cleanup.

---

## Prioritized plan

## Phase 1 — Reduce conceptual overlap in the session query surface

### Goal
Make one retrieval path the default for each question type.

### Changes

1. Make the canonical retrieval surface `top_level_runs`, `cell_ancestors`, `cell_descendants`, `cell_get`, and `ref_read`.
2. Delete `session_last`, `cell_parent`, and `cell_children`.
3. Keep `session_recent`, `get_schema`, `ref_stat`, and `ref_write_to_file` only as secondary helpers, not as the primary retrieval story.
4. Remove deleted names and non-canonical retrieval recipes from model guidance, authoring guidance, docs, tests, and examples.
5. Update tests so guidance asserts only the canonical path.

### Proposed canonical retrieval recipes

- discover top-level chat-visible runs → `top_level_runs(...)`
- inspect nested work under a run → `cell_descendants(...)`
- walk upward to owning run → `cell_ancestors(...)`
- inspect exact cell metadata → `cell_get(...)`
- inspect exact stored value → `ref_read(...)`

### What is intentionally not part of the minimal retrieval surface

- `session_recent(...)` is for global recency scans, not the default retrieval path
- `get_schema(...)` is for shape inspection
- `ref_stat(...)` is for previews/metadata
- `ref_write_to_file(...)` is for exporting values to disk

### Removal policy

Because there are zero users, remove redundant helpers immediately.

- no compatibility wrappers
- no deprecated aliases
- no dual-path prompts or docs
- no tests that preserve old spellings

---

## Phase 2 — Collapse to one MCP transport: HTTP

### Goal
Use one MCP transport end-to-end and delete the redundant stdio transport.

### Changes

1. Change `src/mcp-attachment.ts` to always use `ensureSessionMcpHttpServer(...)`.
2. Delete stdio session MCP attachment and server code.
3. Extract a shared session MCP request handler for the remaining HTTP path.
4. Centralize protocol/server metadata.
5. Centralize arg parsing helpers.

### Acceptance criteria

- nanoboss uses HTTP MCP attachment for Copilot, Claude, Codex, and Gemini
- `src/session-mcp-http.ts` is the only transport shell left
- stdio session MCP server code is deleted
- adding a new MCP tool touches one tool registry, not two dispatchers
- there is one authoritative place for MCP method support

---

## Phase 3 — Collapse session MCP tool registration into one registry

### Goal
Eliminate the array + switch duplication.

### Changes

1. Create a tool definition table.
2. Generate `tools/list` from it.
3. Generate `tools/call` dispatch from it.
4. Keep per-tool argument parsing adjacent to each tool implementation.

### Acceptance criteria

- each tool is defined once
- schema and implementation cannot silently drift apart
- test coverage can iterate the registry rather than ad hoc string literals

---

## Phase 4 — Make internal code consume the same structure it exposes

### Goal
Stop maintaining both a structural and a flat mental model for top-level discovery.

### Changes

1. Rewrite memory-card top-level scanning to use `topLevelRuns()`.
2. Replace ad hoc `recent(...)+kind filter` patterns with structural queries where applicable.
3. Revisit any tests that still encode the old scan-first behavior.

### Acceptance criteria

- top-level discovery is implemented one way internally
- bounded recency scans are used only when global recency is truly intended

---

## Phase 5 — Unify agent execution plumbing

### Goal
Reduce the number of places that know how to talk ACP and the number of places that know how to record agent output.

### Changes

1. Extract shared ACP connection/transcript/config helpers from `call-agent.ts` and `default-session.ts`.
2. Extract shared “record agent run into session store/logger/emitter” helper from `context.ts`.
3. Keep one-shot vs persistent session as separate modes over the same runtime.

### Acceptance criteria

- one place to change permission policy
- one place to change transcript format
- one place to change session config application
- one place to change stream-to-final-output collation rules

---

## Phase 6 — Align procedure authoring with the simplified session model

### Goal
Avoid teaching authors one API while agents use another.

### Changes

1. Expand `ctx.session` to expose the same structural concepts as MCP where they make sense.
2. Remove `ctx.session.last()`.
3. Keep `ctx.session.recent(...)` only for true global-recency queries.
4. Update `src/types.ts`, `/create` prompt guidance, examples, and tests to teach only the canonical session surface.

### Acceptance criteria

- procedure authors and downstream agents are not being taught contradictory discovery models

---

## Phase 7 — Remove incidental boilerplate

### Goal
Trim code that adds noise without adding leverage.

### Changes

1. Convert hand-written `TypeDescriptor` definitions to `jsonType(...)` where practical.
2. Consolidate tiny duplicated helpers like stream text collection and result summarization where they truly mean the same thing.

---

## Suggested implementation order

If this were executed as a focused cleanup series, I would do it in this order:

1. **Phase 1** — delete redundant session query helpers and choose the canonical surface
2. **Phase 2** — collapse to HTTP-only MCP transport
3. **Phase 3** — single tool registry
4. **Phase 4** — internal adoption of structural helpers
5. **Phase 6** — align `ctx.session` and `/create`
6. **Phase 5** — shared ACP runtime / agent bookkeeping
7. **Phase 7** — typia/jsonType cleanup

Reason: with zero users, the best first moves are to shrink the public surface and delete redundant transport infrastructure before spending effort on refactoring around it.

---

## What I would explicitly avoid

1. **Do not introduce a general query language** just to remove a few helper names.
   That would likely be more abstract and less model-friendly.

2. **Do not change the persisted cell file format** in this cleanup pass.
   The storage model is not the problem.

3. **Do not keep deprecated names around just because they are easy to keep.**
   Dead pathways should be removed, not hidden.

4. **Do not over-abstract `SessionStore` first.**
   Reduce public overlap before building clever internals.

---

## Concrete end-state target

The clean version of this subsystem should feel like this:

- one HTTP MCP transport
- one MCP semantics core
- one tool registry
- one canonical minimal retrieval surface for prior turns/runs/cells
- one canonical session traversal vocabulary
- one internal top-level discovery path
- one shared ACP runtime
- one shared agent-run bookkeeping layer
- no compatibility shims for redundant paths

That would materially reduce the number of places an agent or maintainer needs to understand before making changes.

---

## Bottom line

The biggest simplification win is **not** deleting the new structural capability.
It is **choosing one structural vocabulary and one implementation path**, then deleting the redundant paths entirely.

That is the change most likely to improve:

- maintainability
- agent reliability
- bug-fix confidence
- future feature work

---

## Appendix — Copilot HTTP MCP research notes

This appendix records the concrete evidence behind the recommendation to move nanoboss to HTTP-only MCP attachment.

### Conclusion from `~/src/copilot-agent-runtime`

The checked-out Copilot runtime branch appears to support **ACP session-level HTTP MCP servers** already.

That means nanoboss should be able to attach its session MCP server to Copilot using an ACP `mcpServers` entry with `type: "http"`, rather than spawning a stdio MCP subprocess.

### Exact code citations

#### 1. ACP accepts HTTP MCP server descriptors

File:
`/Users/jflam/src/copilot-agent-runtime/src/cli/acp/server.ts`

Key lines:

- `135-166` — `convertAcpMcpServer(...)`
- `137-145` — explicit handling for `server.type === "http"`
- `139-144` — converts ACP HTTP server to internal config:
  - `type: "http"`
  - `url: s.url`
  - `headers: Object.fromEntries(...)`
  - `tools: ["*"]`

This is direct evidence that the ACP layer understands HTTP MCP servers.

#### 2. ACP session creation wires in client-specified MCP servers

File:
`/Users/jflam/src/copilot-agent-runtime/src/cli/acp/server.ts`

Key lines:

- `541-607` — `newSession(params: acp.NewSessionRequest)`
- `568-585` — if `params.mcpServers?.length`, iterate and start them
- `571-576` — convert each ACP server and call `this.mcpHost.startServer(name, config)`
- `581-584` — push resulting MCP config into session options

This shows HTTP MCP servers are not only parsed; they are actually attached during ACP session startup.

#### 3. ACP session resume / load also wires in MCP servers

File:
`/Users/jflam/src/copilot-agent-runtime/src/cli/acp/server.ts`

Key lines:

- `623-689` — `loadSession(params: acp.LoadSessionRequest)`
- `665-681` — same pattern as `newSession(...)` for `params.mcpServers`

This matters for nanoboss because `/default` uses persistent sessions and session resume/load behavior is part of the integration surface.

#### 4. Internal MCP config model includes remote HTTP

File:
`/Users/jflam/src/copilot-agent-runtime/src/mcp-client/types.ts`

Key lines:

- `90-103` — `MCPRemoteServerConfig`
- `91` — remote servers support `type: "http" | "sse"`
- `144-149` — `isRemoteServerConfig(...)` / `isHttpServerConfig(...)`

This shows HTTP is a first-class internal transport, not a one-off ACP shim.

#### 5. Transport factory instantiates Streamable HTTP client transport

File:
`/Users/jflam/src/copilot-agent-runtime/src/mcp-client/factories/transport-factory.ts`

Key lines:

- `20-24` — HTTP transport config shape
- `67-73` — `case "http"` returns `new StreamableHTTPClientTransport(new URL(...), ...)`

This is the strongest execution-path evidence that Copilot can actually speak to MCP over HTTP.

#### 6. Protocol/server-side types expose session MCP config

File:
`/Users/jflam/src/copilot-agent-runtime/src/core/protocol/types.ts`

Key lines:

- `186-199` — remote MCP server config includes `type: "http" | "sse"`
- `336-340` — session request types include `mcpServers?: Record<string, MCPServerConfig>`

This reinforces that HTTP MCP is part of the broader runtime protocol/config story.

#### 7. Tests explicitly cover ACP HTTP MCP conversion

File:
`/Users/jflam/src/copilot-agent-runtime/test/cli/acp/server.test.ts`

Key lines:

- `53-86` — tests for converting `acp.McpServerHttp`
- `55-72` — verifies `type: "http"`, `url`, `headers`, and `tools: ["*"]`

This suggests HTTP MCP support is intentional and protected by tests.

### What nanoboss should send to Copilot

Based on the Copilot ACP conversion code and tests, the expected ACP MCP server shape for nanoboss should be approximately:

```ts
{
  type: "http",
  name: "nanoboss-session",
  url: "http://127.0.0.1:<port>/mcp",
  headers: [],
}
```

Important details:

- `type` should be exactly `"http"`
- `name` should be stable
- `url` should point at the loopback MCP endpoint
- `headers` should be an array of `{ name, value }` pairs, even when empty

That aligns with nanoboss’s existing HTTP server shape in `src/session-mcp-http.ts`.

### Remaining uncertainty

This repo evidence shows the implementation exists on the checked-out Copilot runtime branch.

What it does **not** prove yet:

- that the currently installed `copilot` binary on this machine includes this exact code
- that nanoboss’s specific HTTP MCP endpoint works end-to-end with Copilot without any protocol mismatch

So the design risk is now much smaller, but it is not zero until we run a real integration check.

### Required validation before deleting stdio transport

Before removing nanoboss stdio MCP support, run an explicit validation pass:

1. change `src/mcp-attachment.ts` so Copilot also uses HTTP MCP
2. verify one-shot `ctx.callAgent(...)` can call the nanoboss session MCP tools over HTTP
3. verify `/default` persistent-session flow still works
4. verify resume/load path still works when Copilot reloads a session
5. verify at least one real MCP tool call succeeds:
   - `tools/list`
   - `top_level_runs` or `session_recent`
   - `cell_get`
   - `ref_read`
6. verify no auth/header quirks are required for loopback HTTP
7. once green, delete nanoboss stdio session MCP transport completely

### Why this appendix matters

Without this evidence, keeping both stdio and HTTP might look prudent.

With this evidence, the burden of proof flips:

- stdio is now the extra path
- HTTP is the likely canonical path
- the remaining work is validation, not architectural indecision
