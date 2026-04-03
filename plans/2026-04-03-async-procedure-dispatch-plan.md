# 2026-04-03 Async procedure dispatch migration plan

## Context

Today nanoboss routes slash commands through the persistent master/default conversation by asking the downstream agent to call the `procedure_dispatch` MCP tool.

That fixed the major semantic issues:

- slash commands execute in the master/default session
- token attribution reflects the master session
- nested tool visibility is replayed through the progress sidechannel
- durable session cells remain the source of truth

However, `procedure_dispatch` is still a **single long-lived MCP `tools/call`**.

That means the downstream MCP client owns the timeout. When the client enforces a hard request deadline, long-running procedures like `/research` can fail with errors like:

```text
MCP error -32001: Request timed out
```

Even when nanoboss is still alive and still making progress, the outer MCP call has already failed.

The current timeout recovery path helps if the durable result lands later, but it is a fallback, not the right steady-state protocol.

## Goal

Replace the current blocking `procedure_dispatch` MCP call with an **async start/status/wait protocol** so long-running slash commands no longer depend on one long-lived MCP request surviving client timeouts.

## Non-goals

- changing the durable session cell model
- removing the master/default session routing
- removing nested progress visibility
- redesigning all MCP tooling beyond procedure dispatch
- depending on client-specific heartbeat semantics to extend timeouts

## Desired end state

Instead of:

1. master agent calls `procedure_dispatch`
2. nanoboss blocks until procedure fully completes
3. client may timeout before completion

We want:

1. master agent calls `procedure_dispatch_start`
2. nanoboss returns quickly with a dispatch/job id
3. master agent polls with `procedure_dispatch_status` or `procedure_dispatch_wait`
4. nanoboss reports current state from durable in-process tracking
5. when complete, nanoboss returns the same canonical procedure result shape we use today

This ensures every MCP round-trip is short-lived, so client request deadlines are no longer the limiting factor.

---

## High-level design

## 1. Introduce a durable dispatch job model

Add a lightweight in-memory + disk-backed representation for an async procedure dispatch job.

Suggested shape:

```ts
interface ProcedureDispatchJob {
  dispatchId: string;
  sessionId: string;
  procedure: string;
  prompt: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  dispatchCorrelationId?: string;
  defaultAgentSelection?: DownstreamAgentSelection;
  cell?: CellRef;
  result?: ProcedureExecutionResult;
  error?: string;
}
```

Requirements:

- job ids are stable and unique
- job state survives process restarts if possible
- completed jobs retain enough data for later `status`/`wait` reads
- status can be derived from canonical durable cell/result data, not only transient memory

Suggested location:

- `src/procedure-dispatch-jobs.ts`

Possible persistence location:

- under the session root dir, for example:
  - `sessions/<sessionId>/procedure-dispatch-jobs/<dispatchId>.json`

This keeps dispatch state colocated with other session durability.

---

## 2. Split the single MCP tool into async tools

Add new MCP tools in `src/session-mcp.ts`:

### `procedure_dispatch_start`
Starts the procedure asynchronously and returns quickly.

Suggested input:

```json
{
  "name": "research",
  "prompt": "...",
  "defaultAgentSelection": { "provider": "copilot", "model": "gpt-5.4/xhigh" },
  "dispatchCorrelationId": "optional-correlation-id"
}
```

Suggested output:

```json
{
  "dispatchId": "dispatch_abc123",
  "status": "queued"
}
```

### `procedure_dispatch_status`
Returns current state without blocking for long.

Suggested input:

```json
{
  "dispatchId": "dispatch_abc123"
}
```

Suggested output while running:

```json
{
  "dispatchId": "dispatch_abc123",
  "status": "running",
  "procedure": "research",
  "startedAt": "...",
  "updatedAt": "..."
}
```

Suggested output when completed:

```json
{
  "dispatchId": "dispatch_abc123",
  "status": "completed",
  "result": { ...ProcedureExecutionResult }
}
```

Suggested output when failed:

```json
{
  "dispatchId": "dispatch_abc123",
  "status": "failed",
  "error": "..."
}
```

### `procedure_dispatch_wait`
Optional convenience tool that blocks for a **short bounded interval** and returns either a final result or a still-running status.

Suggested input:

```json
{
  "dispatchId": "dispatch_abc123",
  "waitMs": 1500
}
```

Rules:

- clamp `waitMs` to a small safe ceiling, e.g. 1000-2000ms
- never hold the MCP call long enough to hit typical client timeouts
- if not done by the deadline, return `running`

This tool is useful because it lets the downstream agent poll with fewer loops while still avoiding long-lived MCP requests.

### `procedure_dispatch_cancel`
Optional but likely worth adding for completeness.

---

## 3. Execute jobs outside the MCP request lifetime

`procedure_dispatch_start` must not perform the entire procedure inline before returning.

Instead:

- create the dispatch job record
- schedule background execution
- return immediately

Implementation options:

### Option A: in-process background task

Use `queueMicrotask`, `setTimeout(..., 0)`, or an internal async runner to kick off the procedure after the MCP handler returns.

Important clarification:

- this does **not** inherently require serialization
- multiple jobs can still run concurrently in one process
- what it shares is the same event loop, heap, and crash domain

Pros:
- simple
- lowest code churn
- can still support multiple concurrent jobs if implemented as independent tasks instead of a single global queue

Cons:
- tied to current process lifetime unless backed by durable recovery
- weaker isolation across jobs
- less attractive if we expect many parallel long-lived dispatches

### Option B: detached per-job worker process

Spawn a separate nanoboss helper process that executes the procedure against the same session root.

Pros:
- stronger isolation
- naturally decoupled from request lifetime
- better fit for many parallel long-running jobs
- better failure containment and cancellation semantics

Cons:
- more moving parts
- more orchestration code

### Recommended implementation shape

Do **not** bake the executor choice into the MCP protocol or session-mcp handler.

Instead introduce an executor abstraction early, for example:

```ts
interface ProcedureDispatchExecutor {
  start(job: ProcedureDispatchJob): Promise<void>;
  cancel(dispatchId: string): Promise<void>;
  getStatus(dispatchId: string): Promise<ProcedureDispatchJob>;
}
```

Initial implementations:

- `LocalInProcessDispatchExecutor` (Option A)
- `ChildProcessDispatchExecutor` (Option B)

This lets us:

- land the async MCP protocol independently of the execution strategy
- start with the simpler executor if desired
- switch to a worker-process model later without changing the protocol

### Recommended first step

If we want the lowest-risk migration, start with **Option A behind the executor interface** plus durable on-disk job records.

If parallel long-running dispatches are expected to become common soon, we should strongly consider going directly to **Option B** while keeping the same async MCP protocol.

---

## 4. Reuse the existing top-level procedure execution engine

The actual job body should reuse the shared runner we already have rather than reimplement procedure execution again.

Target:

- `src/procedure-runner.ts` remains the canonical executor
- async dispatch jobs call into that same engine
- result shaping stays identical to current `ProcedureExecutionResult`

This keeps:

- token usage extraction
- default-agent-selection propagation
- cell finalization
- summary/display/data-shape shaping

in one place.

---

## 5. Keep the current nested progress sidechannel

The existing progress bridge in:

- `src/procedure-dispatch-progress.ts`

is still useful.

We should continue to:

- emit nested session/tool progress into the JSONL sidechannel
- replay it in `src/service.ts`
- show hierarchical tool activity in the TUI

The migration to async dispatch should not remove this.

Instead, it becomes cleaner:

- progress is associated with `dispatchId` / `dispatchCorrelationId`
- while the job runs, the service bridges progress into the top-level run
- when the job completes/fails, the bridge shuts down

---

## 6. Update the master-session internal dispatch prompt

The current internal dispatch prompt in `src/service.ts` tells the downstream agent to:

- call `procedure_dispatch` exactly once
- then reply with the tool result text

We will replace that with a loop-oriented contract.

Suggested behavior for the downstream agent:

1. call `procedure_dispatch_start`
2. repeatedly call `procedure_dispatch_wait` or `procedure_dispatch_status`
3. stop only when status is `completed` or `failed`
4. if completed, reply with exactly the returned tool result text
5. if failed, surface the failure text

The prompt should be explicit that:

- this is an internal control flow
- the agent should not improvise its own answer
- the returned `result` object is authoritative

---

## 7. Simplify timeout recovery after async migration

Once dispatch is async, the current timeout recovery path in `src/procedure-dispatch-recovery.ts` should become much less important.

Why:

- there is no longer one long-lived MCP call to time out
- the durable job/result is available through status polling

Recovery still matters for crashes/restarts, but the specific “outer MCP call timed out while underlying job kept running” case should no longer be the primary path.

Post-migration, recovery should focus on:

- process restart during running jobs
- rehydrating job state from disk
- discovering completed jobs from durable cells

That means the existing timeout-specific recovery code can likely be reduced or repurposed.

---

## Migration phases

## Phase 1: Add async job infrastructure

Implement:

- `src/procedure-dispatch-jobs.ts`
- job create/read/update helpers
- durable job persistence under session root
- background executor wrapper around `executeTopLevelProcedure(...)`

Acceptance criteria:

- jobs can be created and observed independently of MCP
- a running job can complete and persist a canonical result

## Phase 2: Add new MCP tools alongside old `procedure_dispatch`

In `src/session-mcp.ts`, add:

- `procedure_dispatch_start`
- `procedure_dispatch_status`
- `procedure_dispatch_wait`
- optionally `procedure_dispatch_cancel`

Keep existing `procedure_dispatch` temporarily for compatibility.

Acceptance criteria:

- async tools work end-to-end in unit tests
- old blocking tool still works during the transition

## Phase 3: Switch service slash-command path to async dispatch

Update `src/service.ts`:

- replace the old single-call dispatch prompt
- use the async start/wait/status protocol in the master session
- keep progress bridge attached during the dispatch lifecycle

Acceptance criteria:

- `/research` and other long-running procedures no longer depend on a long-lived single MCP call
- nested tool visibility still appears in the TUI
- completed run events still contain master-session token usage

## Phase 4: Reduce timeout-specific recovery logic

After the async path is stable:

- audit `src/procedure-dispatch-recovery.ts`
- keep restart/crash recovery
- remove or demote logic that only exists to paper over blocking MCP timeouts

Acceptance criteria:

- code path is smaller and easier to reason about
- recovery remains correct for process interruption scenarios

## Phase 5: Remove legacy blocking `procedure_dispatch`

Once async dispatch is proven stable:

- remove `procedure_dispatch`
- update all tests and internal prompts to use only async dispatch

Acceptance criteria:

- no production slash-command path relies on a single long `tools/call`
- no timeout-specific blocking-dispatch code remains

---

## Detailed implementation notes

## Session MCP API changes

`src/session-mcp.ts` will likely grow methods like:

- `procedureDispatchStart(...)`
- `procedureDispatchStatus(...)`
- `procedureDispatchWait(...)`
- `procedureDispatchCancel(...)`

These should delegate to a dedicated job manager rather than embedding job state logic inline.

## Job completion result shape

The `completed` response should embed the same canonical `ProcedureExecutionResult` currently returned by the blocking tool. That minimizes service-side changes and preserves existing semantics.

## Status updates

A job’s `updatedAt` should advance when:

- job status changes
- nested progress is emitted
- durable cell/result lands

That gives us a heartbeat-like liveness signal **inside nanoboss**, without depending on MCP clients to extend their own tool timeout.

## Wait semantics

`procedure_dispatch_wait` should be bounded and deterministic:

- `waitMs` defaults to a small value, e.g. 1000ms
- maximum value capped to a small ceiling, e.g. 2000ms
- if still running, return current status instead of throwing

This is effectively a nanoboss-controlled heartbeat/TTL model built at the protocol level.

## Cancellation

If implemented, cancellation should:

- mark the job cancelled
- abort the underlying procedure execution if still running
- stop progress bridging

---

## Testing plan

## Unit tests

Add tests for:

- creating a dispatch job
- job persistence/reload
- `procedure_dispatch_start` returns quickly
- `procedure_dispatch_status` reports queued/running/completed/failed
- `procedure_dispatch_wait` returns running before completion and completed afterward
- completed jobs preserve canonical `ProcedureExecutionResult`
- failed jobs preserve error text
- restart/reload can rediscover completed jobs from disk

Suggested files:

- `tests/unit/procedure-dispatch-jobs.test.ts`
- `tests/unit/session-mcp.test.ts`
- `tests/unit/service.test.ts`

## Integration/e2e tests

Update and extend:

- `tests/e2e/procedure-dispatch-recovery.test.ts`

New expectations:

- long-running `/research` does not fail with MCP timeout solely due to one blocking call
- nested tool progress remains visible
- final top-level completion still contains master-session token usage
- optional crash/restart recovery still works

## Regression checks

Verify that:

- `/model` changes still propagate into async-dispatched procedures
- memory cards and prompt diagnostics still behave as expected
- session refs/cells remain exact and durable
- TUI activity tree still shows nested progress coherently

---

## Risks

## 1. Background execution lifetime

If we use in-process background jobs, process shutdown during a running job needs clear handling.

Mitigation:

- durable job record with status
- on startup/reload, reconcile jobs against durable cells/results

## 2. Duplicate execution after restart

A restarted process must not accidentally rerun an already-completed dispatch.

Mitigation:

- persist job status transitions carefully
- treat completed cell/result as authoritative
- use `dispatchCorrelationId` to deduplicate

## 3. More MCP tool chatter

Async polling increases tool-call count.

Mitigation:

- use short bounded `wait` instead of very frequent raw status polling
- keep responses compact

## 4. Prompt compliance by the downstream agent

The master agent must follow the start/wait/status loop reliably.

Mitigation:

- make the internal dispatch prompt extremely explicit
- keep the tool API simple
- add tests with the mock agent and real-agent opt-in e2e coverage

---

## Why this is better than heartbeat-based timeout extension

A heartbeat+TTL model would only help if the MCP client itself:

- receives the heartbeat
- interprets it as liveness
- resets its request timeout

We do not control that behavior, and we should not assume all MCP clients will behave that way.

So while start/status/wait is not claimed here as an explicit MCP-spec mandate, it is the safest interoperable design for long-running work when client request deadlines may be hard and non-extendable.

Async dispatch avoids that dependency entirely:

- every MCP request is short
- nanoboss controls liveness/status semantics itself
- durable state stays authoritative

So this migration is the protocol-level fix, not a heuristic workaround.

---

## Acceptance criteria for the overall migration

1. No production slash-command path depends on a single long-lived MCP `tools/call`.
2. Long-running procedures like `/research` can run for much longer than the client’s per-request timeout without surfacing MCP timeout failures.
3. Nested tool visibility remains intact in the TUI.
4. Completed slash commands still attribute token usage to the master/default session.
5. Durable session cells/refs remain the authoritative source of truth.
6. Restart/crash recovery remains supported.
7. The old timeout-recovery glue is substantially reduced after the async path lands.
