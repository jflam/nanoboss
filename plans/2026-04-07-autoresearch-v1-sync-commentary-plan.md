# 2026-04-07 autoresearch v1: synchronous loop with chat commentary

## Decision

The first desirable NanoBoss version of `/autoresearch` should be **synchronous, foreground, and chat-progressive**.

The v1 goal is **not** to prove async dispatch, dashboards, or long-running background orchestration. The v1 goal is to prove that the autoresearch loop itself can:

1. initialize a clean optimization session
2. run a few deterministic iterations in the foreground
3. narrate progress in chat as it works
4. preserve durable repo-local state, logs, and summaries
5. produce at least one reviewable improvement when the benchmark allows it

Async dispatch remains a later execution mode, not the definition of the feature.

---

## Why this is the right v1

This keeps NanoBoss close to the important semantics of `pi-autoresearch` without taking on the hardest UX and orchestration work before the optimization loop is proven.

What matters most in `pi-autoresearch` is not "backgroundness" by itself. What matters is:

- deterministic outer-loop control
- durable experiment state
- keep/revert discipline
- resumability from structured artifacts
- a useful user experience while the loop is operating

A synchronous first iteration can preserve all of that except true background execution, and it can deliver a compelling UX immediately by streaming progress commentary into the chat.

---

## Product objective for v1

When a user runs:

```text
/autoresearch <goal>
```

NanoBoss should:

1. create or resume the autoresearch session
2. run the baseline and a bounded number of iterations **in the same foreground procedure call**
3. stream concise "observer commentary" as the loop proceeds
4. finish with a clear summary of what happened and what the current best result is

The user should feel like they are **watching the research happen live** in the chat, not waiting silently for one big response.

---

## Grounding in the current codebase

This v1 can be built by evolving the current implementation rather than replacing it.

### Existing pieces we can keep

#### 1. Durable repo-local state already exists

The current autoresearch runner already writes:

- state via `writeAutoresearchState(...)`
- append-only run history via `appendExperimentRecord(...)`
- summary markdown via `writeAutoresearchSummary(...)`

Those are the right foundations for a sync-first v1 and should remain the source of truth.

#### 2. Deterministic experiment execution already exists

`src/autoresearch/runner.ts` already contains the core deterministic pieces:

- baseline execution through `runBenchmark(...)` and `runChecks(...)`
- one-iteration execution through `executeExperimentRun(...)`
- state transitions through `updateStateAfterRecord(...)`
- keep/revert decisions in deterministic code

This is already the hard part of the feature. The v1 should reuse it.

#### 3. We already have a streaming hook for user-visible progress

`CommandContext.print(text)` is already part of the procedure API (`src/core/types.ts`) and is implemented by emitting `agent_message_chunk` updates in `src/core/context.ts`.

That means a procedure can stream human-facing progress lines to the chat **today**, without inventing a new transport layer.

#### 4. Agent calls are already bounded and quiet

The current autoresearch runner already uses `ctx.callAgent(..., { stream: false })` for:

- initialization planning
- experiment proposal
- experiment application

That is ideal for the desired UX: the host procedure can keep agent chatter quiet and print its own curated commentary instead.

#### 5. The current tests already cover the core loop semantics

`tests/unit/autoresearch-command.test.ts` already covers:

- initialization
- resume behavior
- kept vs. rejected experiments
- failing checks
- stop / clear / finalize flows

That means we can evolve the execution mode while preserving existing semantic coverage.

### Existing piece we should *not* lean on for v1

The current implementation routes continuation through async dispatch:

- `executeAutoresearchCommand(...)` initializes or resumes, then launches async continuation
- `executeAutoresearchLoopCommand(...)` performs one iteration and queues the next dispatch

For v1, that dispatch chaining is unnecessary complexity. The one-iteration loop logic is useful; the async chaining is what should be deferred.

---

## Desired v1 user experience

The synchronous loop should stream commentary like a calm, high-signal observer.

Examples of the tone:

- `Configuring autoresearch session...`
- `Baseline: bun test -> 118.4s.`
- `Iteration 1/3: looking for test harness overhead.`
- `Candidate: reduce repeated fixture setup in tests/e2e/...`
- `Benchmarking candidate...`
- `Result: 111.2s, improvement kept.`
- `Current best: 111.2s on autoresearch/reduce-bun-test-runtime.`
- `Iteration 2/3: exploring serialization overhead in shared helpers.`
- `Result: 113.0s, reverted.`
- `Autoresearch finished after 3 iterations. Best runtime: 109.8s.`

The commentary should be:

- concise
- state-based
- deterministic in structure
- written by NanoBoss host code, not streamed raw from the agent

---

## Proposed v1 behavior

### `/autoresearch <goal>`

Primary entrypoint for v1.

Behavior:

1. initialize the session if no state exists
2. run the baseline
3. synchronously execute up to a bounded number of iterations
4. stream commentary throughout
5. end with a durable summary and a final result

### `/autoresearch resume ...`

Continue an existing session in the foreground.

Behavior:

1. append any resume note into state
2. synchronously run more iterations from the current best state
3. stream commentary using the same format as initial execution

### `/autoresearch status`

Keep this command.

It remains useful in v1 because state is still durable and resumable.

### `/autoresearch-finalize`

Keep this command.

It remains part of the user story even when the loop itself is synchronous.

### `/autoresearch-clear`

Keep this command.

It remains useful for resetting repo-local artifacts.

### `/autoresearch-stop`

De-emphasize or defer.

For a foreground-only v1, stop is not central because there is no background worker to interrupt. We should keep the command vocabulary in mind, but it does not need to drive the initial implementation.

---

## Proposed implementation shape

### 1. Keep initialization and iteration semantics; remove async chaining from the v1 path

The current code already has two valuable layers:

- initialization in `executeAutoresearchCommand(...)`
- one-iteration execution in `executeAutoresearchLoopCommand(...)`

For v1, the command path should change from:

1. initialize
2. queue async loop

to:

1. initialize
2. run a bounded synchronous loop in-process
3. return a final foreground result

### 2. Extract a reusable single-iteration helper

The code inside `executeAutoresearchLoopCommand(...)` should be refactored into a helper that performs one deterministic iteration and returns structured data describing:

- what experiment was chosen
- what was benchmarked
- whether it was kept / rejected / failed
- what the new best metric is
- whether execution should continue

That helper can power both:

- the synchronous v1 foreground loop
- a future async loop runner

This keeps async as a future runner choice rather than a separate logic path.

### 3. Add a foreground loop driver

Introduce a driver in `src/autoresearch/runner.ts` with a shape like:

1. load / initialize state
2. emit baseline commentary
3. while session is active and budget remains:
   - emit iteration-start commentary
   - run one iteration
   - emit decision commentary
4. write final summary
5. return final `ProcedureResult`

This driver should become the primary behavior for `/autoresearch` and `resume` in v1.

### 4. Introduce host-owned commentary formatting

Add a small formatter layer, something conceptually like:

- `emitAutoresearchProgress(ctx, event)`
- `formatAutoresearchProgress(event)`

The event model should be structured and deterministic. Candidate event kinds:

- `session_configuring`
- `baseline_started`
- `baseline_completed`
- `iteration_started`
- `candidate_selected`
- `candidate_applied`
- `benchmark_started`
- `benchmark_completed`
- `checks_failed`
- `decision_kept`
- `decision_reverted`
- `decision_failed`
- `session_completed`

All commentary should flow through `ctx.print(...)`.

### 5. Keep agent reasoning quiet and bounded

Continue to use `ctx.callAgent(..., { stream: false })`.

The user-facing text should come from the commentary formatter rather than raw downstream-agent output. That keeps the UX coherent and lets us change agents later without rewriting the chat experience.

### 6. Preserve durable files from day one

Even in the synchronous v1, keep writing:

- `autoresearch.state.json`
- `autoresearch.jsonl`
- `autoresearch.md`

This preserves the most valuable `pi-autoresearch` behavior and makes later async or dashboard work incremental.

---

## What should be explicitly deferred from v1

1. async dispatch chaining
2. background workers
3. `/autoresearch-stop` as an active interruption primitive
4. dashboard or widget UI
5. check-in / polling surfaces for background work
6. dispatch-lane ACP isolation work

Those are important follow-ons, but they should not block the synchronous proof of value.

---

## Testing plan

### Update existing unit tests

Adapt `tests/unit/autoresearch-command.test.ts` so the v1 command path verifies synchronous progression rather than queued dispatch IDs.

Examples:

1. initialization test should assert baseline files exist and at least one foreground iteration can run
2. resume test should assert more iterations occur synchronously
3. keep / reject / fail tests should continue to verify durable loop semantics

### Add commentary-focused tests

Add unit coverage that captures printed progress and verifies high-signal output for:

1. baseline completion
2. iteration start
3. kept improvement
4. reverted regression
5. final summary

### Keep finalize coverage

The existing finalize tests should still pass because the durable log / commit model remains intact.

---

## Acceptance criteria

The v1 is successful when all of the following are true:

1. `/autoresearch <goal>` runs in the foreground without async dispatch.
2. The user sees streamed progress commentary throughout the run.
3. Repo-local state, log, and summary files are still created and updated.
4. The loop still keeps wins, reverts regressions, and records failures deterministically.
5. `/autoresearch status`, `/autoresearch-clear`, and `/autoresearch-finalize` still work with the same durable artifacts.
6. The implementation remains structurally compatible with a later async runner.

---

## Implementation todos

1. extract single-iteration loop logic from `executeAutoresearchLoopCommand(...)`
2. add a synchronous foreground loop driver for `/autoresearch`
3. introduce structured commentary events and `ctx.print(...)` formatting
4. remove dispatch-driven continuation from the v1 command path
5. update autoresearch unit tests for synchronous execution and streamed commentary

---

## Notes on alignment with `pi-autoresearch`

This v1 intentionally diverges on **execution mode**, not on **feature semantics**.

It preserves the parts of `pi-autoresearch` that matter most:

- durable state
- deterministic control
- resumability
- structured experiment history
- later finalization of kept wins

What it postpones is only the product surface for background execution. That is an acceptable v1 tradeoff as long as the sync loop is built so that a future async runner can reuse the same core iteration engine and commentary event model.
