# 2026-03-31 Plan: Show Nested ACP Tool Calls in Procedure Tool Trace

## Status

Planned, intentionally deferred.

This plan covers one focused UX improvement:

- when a procedure calls `ctx.callAgent(...)`
- and that downstream agent emits ACP `tool_call` / `tool_call_update`
- surface those nested tool events in the top-level CLI / frontend trace
- even when the procedure suppresses downstream text streaming

This is separate from the more urgent chat-history / multi-turn context gap.

---

## Problem statement

Today many procedures call downstream agents with:

```ts
ctx.callAgent(prompt, { stream: false })
```

That is often correct for text output because:

- we do not always want raw downstream prose dumped into the terminal
- typed calls should usually stay buffered until final validation
- procedures often want to control their final rendered output themselves

However, the current implementation also suppresses nested ACP tool telemetry when `stream: false` is set.

That means the user loses useful observability for nested agent work such as:

- file reads
n- shell commands
- tool progress/status changes
- nested agent behavior during longer procedures like `/second-opinion`

The result is that the tool trace looks incomplete even though the underlying ACP events exist.

---

## Current behavior

The relevant behavior lives in `src/context.ts`.

For nested `ctx.callAgent(...)` invocations, the transport callback currently forwards downstream session updates only when streaming is enabled. In practice that means:

- `agent_message_chunk` is suppressed when `stream: false`
- `tool_call` is also suppressed when `stream: false`
- `tool_call_update` is also suppressed when `stream: false`

So one option currently controls two distinct concerns:

1. **text streaming**
2. **tool telemetry visibility**

That coupling is the design bug.

---

## Design goal

Decouple these concerns.

Desired default semantics:

- suppress nested text chunks when a procedure asks for buffered behavior
- still forward nested tool-call telemetry unless explicitly disabled

In short:

- **text streaming** should be optional
- **tool trace visibility** should remain on by default

---

## Proposed API direction

### Short-term compatibility change

Preserve the existing API shape but reinterpret `stream: false` more narrowly:

- `stream: false` means **do not forward `agent_message_chunk`**
- but **still forward `tool_call` and `tool_call_update`**

This should deliver the desired UX with minimal breakage and very little code churn.

### Longer-term cleanup

If we want cleaner semantics later, evolve `CommandCallAgentOptions` toward something like:

```ts
interface CommandCallAgentOptions {
  agent?: DownstreamAgentSelection;
  refs?: Record<string, CellRef | ValueRef>;
  streamText?: boolean;      // default true
  streamToolCalls?: boolean; // default true
  stream?: boolean;          // backward-compat shim
}
```

Suggested interpretation:

- `stream: false` => equivalent to `streamText: false`
- leave `streamToolCalls: true` unless explicitly disabled

That gives us a more honest model without forcing a large migration immediately.

---

## Implementation plan

### Phase 1: Minimal behavioral fix

Update nested-agent update forwarding in `src/context.ts`.

Current shape is roughly:

- if `stream !== false`
  - forward text chunks
  - forward tool call events
  - forward tool call updates

Change to:

- if update is `agent_message_chunk`
  - forward only when text streaming is enabled
- if update is `tool_call`
  - forward by default
- if update is `tool_call_update`
  - forward by default

This should be the smallest useful fix.

### Phase 2: Preserve output de-duplication guarantees

Verify the change does not reintroduce the duplicate-output bug we already fixed.

In particular:

- nested tool events should appear
- nested text should remain suppressed when requested
- final `display` should still not duplicate prior streamed text

### Phase 3: Add tests

Add deterministic coverage using the existing mock-agent-backed HTTP/SSE test setup.

#### Unit coverage

Likely in `tests/unit/...` or `tests/unit/service/context-related` coverage:

- nested `ctx.callAgent(..., { stream: false })`
- mock downstream updates include:
  - `tool_call`
  - `tool_call_update`
  - `agent_message_chunk`
- assert:
  - tool events are published
  - text events are not

#### E2E coverage

Likely in `tests/e2e/...` with the mock agent:

- create a procedure/flow that invokes a nested agent call with `stream: false`
- make the mock agent emit one tool call + one completion update + one text chunk
- assert CLI output shows:
  - nested tool trace lines
- assert CLI output does **not** show:
  - raw nested text chunk

This is important because the UX goal is specifically about what the operator sees.

### Phase 4: Optional API cleanup

If Phase 1 works well, consider a follow-up that adds explicit `streamText` / `streamToolCalls` options.

That follow-up is not required for the initial fix.

---

## Files likely involved

Primary:

- `src/context.ts`

Possible follow-up / test updates:

- `src/types.ts`
- `tests/e2e/helpers.ts`
- `tests/fixtures/mock-agent.ts`
- new or updated tests in `tests/e2e/*.test.ts`
- possibly `src/create.ts` if we want generated procedure guidance to describe the new semantics

---

## Non-goals

This plan does **not** attempt to solve:

- multi-turn chat history being absent from `/default`
- prior procedure outputs being injected into subsequent prompts
- frontend rendering changes beyond surfacing existing tool trace lines
- a full streaming API redesign

Those are separate problems.

---

## Risks / caveats

### 1. Trace noise

If procedures make many nested agent calls, surfacing all nested tool telemetry may make the trace noisier.

Current judgment: acceptable, and probably desirable by default.

### 2. Ambiguity between top-level and nested tool calls

If needed later, we may want visual distinction such as:

- nesting markers
- parent procedure labels
- run IDs in structured frontend events

But this is not required for the first iteration.

### 3. Backward-compat semantics

If any caller relied on `stream: false` meaning “absolutely no downstream updates of any kind,” this change slightly widens what is visible.

Current judgment: that is the intended UX improvement and worth the change.

---

## Success criteria

This work is successful if all of the following are true:

1. nested `ctx.callAgent(..., { stream: false })` still suppresses raw text chunks
2. nested ACP `tool_call` events become visible in CLI / SSE traces
3. nested ACP `tool_call_update` events become visible in CLI / SSE traces
4. no duplicate final text output is introduced
5. deterministic tests cover the behavior

---

## Recommendation

When we pick this up, start with the smallest possible fix in `src/context.ts` and add deterministic mock-agent-backed tests immediately.

Do **not** redesign the whole streaming API first.

The likely correct sequence is:

1. decouple nested tool telemetry from text streaming
2. test it end to end
3. only then decide whether explicit `streamText` / `streamToolCalls` options are worth adding
