# 2026-04-06 ESC stop-at-boundary plan

## Goal

Make `Esc` in the nanoboss TUI behave as a **soft stop**:

- acknowledge the keypress immediately in the TUI
- show that acknowledgement in the top ghost/status line before any backend stop completes
- stop at the **next tool boundary** instead of killing the downstream agent process
- debounce repeated `Esc` presses so users do not spam cancel requests while waiting for the stop to land
- keep `Ctrl+C` as the hard exit / teardown path

---

## Current behavior

Nanoboss already has a partial `Esc` plumbing path:

- `src/tui/app.ts`
  - maps `Esc` to `controller.cancelActiveRun()`
- `src/tui/views.ts`
  - advertises `esc stop` in the footer while a run is active
- `src/http/client.ts` and `src/http/server.ts`
  - send and receive `/v1/sessions/:id/cancel`
- `src/core/service.ts`
  - translates cancel into `abortController.abort()`

That is enough for wiring, but not for the desired UX or execution semantics.

### Current problems

1. **No immediate latched stop state in the TUI**
   - the UI can show `[run] cancelling…`, but that state is not protected from later heartbeat/status updates
   - there is no explicit debounce or "already received" state for repeated `Esc`

2. **Cancel is implemented as abort-now, not stop-at-boundary**
   - downstream ACP prompts receive an abort signal
   - `src/agent/call-agent.ts` and `src/agent/default-session.ts` send ACP cancel and then close the transport
   - `src/agent/acp-runtime.ts` closes the transport by killing the child process

3. **The next tool can still start after stop is requested**
   - there is no durable session-level "stop requested" latch checked before starting `ctx.callAgent(...)`, `ctx.callProcedure(...)`, or `ctx.continueDefaultSession(...)`
   - one-shot ACP calls also need an already-aborted preflight check before they begin

4. **Cancelled work is not modeled distinctly**
   - current flows tend to land as generic failure/error paths rather than a clear cancelled/stopped outcome

---

## Recommended behavior

### UX

On the first `Esc` press during an active run:

- consume the key immediately
- set a local stop-requested flag immediately
- update the top ghost/status line immediately to something like:
  - `[run] ESC received - stopping at next tool boundary...`
- send exactly one backend stop request for the current run

On repeated `Esc` presses for that same active run:

- consume the key
- do not send another cancel request
- keep the existing ghost/status line stable

### Runtime semantics

- `Esc` means **soft stop**
- nanoboss should not kill the downstream process on `Esc`
- the current in-flight tool/procedure call may finish or cooperate with ACP cancel
- nanoboss must refuse to start the **next** tool/procedure boundary once stop has been requested
- `Ctrl+C` remains the hard local exit path and is the only path that should tear down the live transport/process immediately

---

## Proposed implementation plan

## Phase 1: Add a latched stop-requested UI state with debounce

### Why

The user needs immediate confidence that `Esc` was received, even if the current tool takes time to yield.

### Recommendation

Extend TUI state with explicit stop-requested metadata for the active run.

### Suggested state direction

Add fields to `src/tui/state.ts` such as:

- `stopRequestedRunId?: string`
- `stopRequestedAtMs?: number`

Use a dedicated reducer action like:

- `local_stop_requested`

Behavior:

- first `Esc` while `inputDisabled` and `activeRunId` is set:
  - latch `stopRequestedRunId = activeRunId`
  - set `statusLine` to the immediate acknowledgement message
- repeated `Esc` while the same run is active:
  - no-op except consume input

### Important reducer behavior

- `run_heartbeat` must not overwrite the acknowledgement line while `stopRequestedRunId === activeRunId`
- `run_started` for a new run must clear prior stop-requested state
- `run_completed` / `run_failed` / cancelled completion must clear the stop-requested state

### Files likely involved

- `src/tui/state.ts`
- `src/tui/reducer.ts`
- `src/tui/controller.ts`
- `src/tui/app.ts`
- `tests/unit/tui-app.test.ts`
- `tests/unit/tui-controller.test.ts`

---

## Phase 2: Introduce a session-level soft-stop latch in the backend

### Why

A plain `AbortController.abort()` is too blunt. Nanoboss needs a durable "stop requested" state that survives long enough to block the next boundary.

### Recommendation

Extend session state in `src/core/service.ts` with explicit stop-request metadata, independent from any transport teardown.

### Suggested shape

Per session:

- `stopRequested: boolean`
- `stopRequestedRunId?: string`

Cancel endpoint behavior:

- set the stop-requested latch for the current run
- optionally signal the currently active downstream ACP call cooperatively
- do not tear down the whole ACP transport/process

Prompt lifecycle behavior:

- clear stale stop-requested state before a new run starts
- keep the latch associated with the current run only

### Files likely involved

- `src/core/service.ts`
- possibly `src/http/frontend-events.ts` if a cancelled run event is added
- `src/http/server.ts`

---

## Phase 3: Enforce stop-at-boundary in command execution

### Why

The key semantic requirement is: once `Esc` is requested, nanoboss must not begin the next tool/procedure boundary.

### Recommendation

Add a small reusable stop-check helper in the command execution layer and call it before every boundary transition.

### Boundaries to guard

- before `ctx.callAgent(...)`
- before `ctx.callProcedure(...)`
- before `ctx.continueDefaultSession(...)`
- before top-level procedure dispatch into the default conversation when applicable

### Suggested implementation direction

In `CommandContextImpl`, add a helper that checks the session stop latch and throws a dedicated cancellation error when stop has been requested.

This should run:

- before starting a child cell
- before emitting a new tool start event
- before starting any downstream prompt call

That ensures a stop requested between tool calls lands before the next boundary begins.

### Files likely involved

- `src/core/context.ts`
- `src/procedure/runner.ts`
- `src/core/service.ts`

---

## Phase 4: Make ACP cancel cooperative and remove process-kill behavior from Esc

### Why

The current abort path collapses into transport shutdown and child-process kill, which is not the desired behavior for `Esc`.

### Recommendation

Separate **soft stop** from **hard teardown**.

### Required changes

For `Esc` / soft stop:

- send ACP `cancel({ sessionId })` when a prompt is currently in flight
- do not immediately call `closeAcpConnection()`
- do not immediately `child.kill()`

For hard shutdown (`Ctrl+C`, app shutdown, explicit teardown):

- keep existing transport/process cleanup behavior

### Special case

One-shot ACP prompts in `runAcpPrompt()` must check for an already-requested stop before starting. Without that preflight check, nanoboss can still begin a new one-shot tool after the user pressed `Esc`.

### Files likely involved

- `src/agent/call-agent.ts`
- `src/agent/default-session.ts`
- `src/agent/acp-runtime.ts`

---

## Phase 5: Model cancelled outcomes distinctly

### Why

A cooperative stop should not look like a generic failure.

### Recommendation

Introduce a clear cancelled/stopped outcome through the relevant event and UI layers.

### Desired behavior

- in-flight tool cards should be able to end as `cancelled`
- the top-level run should surface a stopped/cancelled status, not an error
- transcript text should avoid implying a crash or failure when the user explicitly requested stop

### Likely change directions

Either:

- add a dedicated frontend run-cancelled event

or:

- continue using `run_failed` temporarily but carry structured cancelled metadata and render it distinctly

The cleaner long-term option is a distinct cancelled event/status.

### Files likely involved

- `src/http/frontend-events.ts`
- `src/tui/reducer.ts`
- `src/tui/components/tool-card.ts`
- `src/core/context.ts`
- `src/core/service.ts`

---

## Phase 6: Test the full soft-stop behavior

### Why

Current tests only prove that `Esc` triggers a cancel request. They do not prove stop-at-boundary semantics or debounce.

### Test split

Most of Phase 6 should stay in **unit tests**.

Unit coverage is the right fit for:

- immediate ghost/status-line acknowledgement
- `Esc` debounce for the active run
- heartbeat protection for the latched stop message
- boundary checks that prevent the next `ctx.callAgent(...)` / `ctx.callProcedure(...)` from starting
- cancelled-state rendering in the reducer/view layer

Use a **mock ACP agent path** only for the transport-specific soft-stop behavior:

- proving nanoboss sends ACP `cancel(...)`
- proving `Esc` does not kill the downstream child process
- proving the run can remain alive long enough to stop cooperatively instead of tearing down immediately

### Mock-agent recommendation

Do **not** create a brand-new fixture unless the existing one becomes too awkward.

Prefer extending `tests/fixtures/mock-agent.ts` with an env-gated cooperative-cancel mode that:

- starts a deterministic long-running prompt
- records per-session cancel state
- yields when `cancel(...)` arrives
- stays alive after cancel so the test can prove `Esc` did not hard-kill the process

That keeps the ACP-specific integration coverage narrow while leaving the rest of Phase 6 fast and local.

### Add tests for

1. **Immediate UI acknowledgement**
   - first `Esc` updates the ghost/status line immediately

2. **Debounce**
   - repeated `Esc` during the same run sends one cancel request only

3. **Heartbeat stability**
   - heartbeats do not overwrite the stop-requested status line

4. **Boundary stop**
   - if `Esc` lands between two `ctx.callAgent(...)` calls, the second one never starts

5. **Soft stop vs hard exit**
   - `Esc` does not kill the ACP transport/process
   - `Ctrl+C` still exits/tears down

6. **Cancelled rendering**
   - stopped work renders as cancelled/stopped rather than failed

### Likely files

- `tests/unit/tui-app.test.ts`
- `tests/unit/tui-controller.test.ts`
- `tests/unit/...` around `CommandContextImpl` / procedure runner
- `tests/fixtures/mock-agent.ts`
- possibly a focused integration test around downstream ACP cancel behavior

---

## Notes and considerations

- True "next tool boundary" behavior depends on nanoboss controlling **its own** boundary checks. It cannot force an arbitrary downstream tool to yield instantly.
- The most important UX contract is immediate acknowledgement in the ghost/status line plus debounced input handling.
- `Esc` should be safe and boring: it asks the run to stop and then waits. It should not tear down the process tree.
- `Ctrl+C` remains the intentional hard-stop/exit path.
- Prefer explicit cancellation types/errors over broad reuse of generic failure paths; that keeps logs, UI, and future retry logic clean.
