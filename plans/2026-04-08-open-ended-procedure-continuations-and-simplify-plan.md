# Open-ended procedure continuations and `/simplify`

## Why this was built

The starting problem was that nanoboss procedures were effectively single-shot:

- `execute(prompt, ctx)` ran once
- the top-level procedure cell was finalized immediately
- the frontend only understood started/completed/failed/cancelled runs
- there was no native way for a procedure to ask the user an open-ended question, wait, and continue later with durable state

That limitation mattered for the new `/simplify` workflow. The desired UX was:

1. Scan the repo for a simplification opportunity.
2. Present one concrete opportunity.
3. Ask the user what they want to do.
4. Accept freeform replies like:
   - "apply it"
   - "skip this one"
   - "stop"
   - "look for dead code instead"
   - "focus on duplicate code"
5. Continue the same procedure with remembered state.

The implementation therefore added a first-class **paused procedure** model and then built `/simplify` on top of it.

---

## What was created

Two things were added:

1. **A general pause/resume mechanism for procedures**
2. **A new built-in `/simplify` procedure** that uses that mechanism

The design chosen was a **durable paused state machine**, not a live in-memory coroutine. That means:

- procedure state is serialized and persisted
- the session can be resumed later
- the next plain-text user message can resume the paused procedure
- explicit slash commands still work and do not accidentally consume the paused continuation

---

## High-level architecture

### 1. Procedure contract changes

Procedures can now do more than return terminal results.

The core model now supports:

- a `pause` payload on `ProcedureResult`
- an optional `resume(prompt, state, ctx)` method on `Procedure`
- a `ProcedurePause` shape carrying:
  - `question`
  - durable `state`
  - optional `inputHint`
  - optional `suggestedReplies`

This turns procedure execution into a simple state machine:

- `execute(...)` can either finish or pause
- `resume(...)` receives the user reply plus the persisted state
- `resume(...)` can then finish or pause again

### 2. Session-level continuation routing

The service layer now stores a `pendingProcedureContinuation` on the session.

That stored continuation contains:

- the paused procedure name
- the originating top-level cell ref
- the question shown to the user
- the persisted continuation state
- optional input hint / suggested replies

Routing rules:

- if there is **no** pending continuation, plain text still goes to `/default`
- if there **is** a pending continuation, the next **non-slash** reply is routed back to that procedure's `resume(...)`
- if the user enters an explicit slash command, that command runs normally and the pending continuation remains in place

This was the key change needed to support open-ended replies like "do something else instead".

### 3. Frontend event changes

A new frontend event was added:

- `run_paused`

This event carries:

- procedure name
- paused timestamp
- cell ref
- user-facing question
- optional display text
- optional input hint
- optional suggested replies
- optional token usage

The paused event is treated as a terminal boundary for the current run, but unlike completion/failure/cancel:

- the TUI re-enables input
- the status line changes to a waiting-for-reply state
- the assistant text remains visible as the prompt for the next user turn

### 4. Persistence and replay

Pause state is persisted in two places:

1. **Cell output**
   - so the paused result is part of the durable execution record
   - includes a `pauseRef`

2. **Session metadata**
   - so the session knows there is a pending continuation even after restart

Replay / restore behavior was also updated so restored runs can be marked as:

- complete
- failed
- cancelled
- **paused**

That allows resumed sessions to restore the paused run state correctly.

---

## File-by-file implementation plan (reverse engineered from the shipped changes)

### `src/core/types.ts`

This is where the new protocol surface was introduced.

Added:

- `ProcedurePause<TState>`
- `PendingProcedureContinuation<TState>`
- `pause?: ProcedurePause` on `ProcedureResult`
- `pause?: ProcedurePause` and `pauseRef?: ValueRef` on `RunResult`
- `resume?(prompt, state, ctx)` on `Procedure`
- `run_paused` in persisted/frontend event unions
- `run_paused` token-usage source support

This file is the type-level foundation for the whole change.

### `src/session/store.ts`

This file was updated so paused results are stored durably in procedure cells.

Added behavior:

- store `pause` in `CellRecord.output`
- expose `pauseRef`
- include `pause`/`pauseRef` in returned `RunResult`

This makes pause state inspectable and durable like other result payloads.

### `src/session/repository.ts`

This file was updated to persist session-level pending continuations.

Added:

- `pendingProcedureContinuation?: PendingProcedureContinuation` on `SessionMetadata`
- parsing logic for that metadata
- parsing helpers for the stored cell ref and continuation payload

This is what allows a paused procedure to survive session restart and `nanoboss resume`.

### `src/procedure/runner.ts`

This file was extended so the top-level runner understands both pause and resume.

Added:

- support for executing a procedure in **resume mode**
- `pause` / `pauseRef` on `ProcedureExecutionResult`
- `buildRunPausedEvent(...)`

This change keeps pause handling in the same place that already builds completion/cancellation events.

### `src/core/service.ts`

This is the main orchestration change and the largest part of the work.

Added behavior:

- store `pendingProcedureContinuation` in `SessionState`
- persist that state in session metadata
- restore it on session resume
- route plain text back into the paused procedure via `resolveCommand(...)`
- call `resume(...)` when continuing a paused procedure
- publish `run_paused`
- keep paused continuations alive across unrelated slash commands
- clear continuations only when the resumed procedure actually reaches a terminal non-paused result
- replay paused runs as `run_restored` with `status: "paused"`
- persist `run_paused` in replay logs

Conceptually, this file changed the runtime from:

- "every prompt independently resolves to a command"

to:

- "a prompt may either start a command or continue a paused command"

### `src/http/frontend-events.ts`

This file was updated to reflect the expanded frontend event protocol.

Added:

- `run_paused` event type
- `paused` as a valid restored-run status
- `run_paused` as a token-usage source

This keeps the frontend/server event model aligned with the new runtime behavior.

### `src/tui/reducer.ts`

This file was changed so paused runs behave correctly in the CLI UI.

Added behavior:

- handle `run_paused`
- re-enable input on pause
- set the status line to a waiting-for-reply state
- treat restored paused runs as completed assistant turns visually rather than a permanently streaming turn

This is the reason the user can immediately type their freeform follow-up after `/simplify` pauses.

### `src/tui/controller.ts`

This file was updated so paused runs count as terminal boundaries for prompt queueing behavior.

Added behavior:

- `run_paused` is treated like a terminal event for pending prompt flushing logic

Without this, the UI would still think the run was active.

### `src/procedure/registry.ts`

This file was updated to register the new built-in:

- `simplify`

### `src/procedure/create.ts`

This file was updated so generated procedures know about the new API.

The prompt for `/create` now describes:

- optional `resume(...)`
- `pause: { question, state, inputHint?, suggestedReplies? }`

This keeps the procedure-generation surface aligned with the runtime that now exists.

### `procedures/simplify.ts`

This is the new user-facing procedure built on the pause/resume mechanism.

It implements a loop as a durable state machine:

#### Execute phase

- normalize the initial focus prompt
- ask the agent to find **one** simplification opportunity
- if none exists, finish immediately
- otherwise build `SimplifyState` and return a paused result

#### Resume phase

- validate the stored state
- classify the user's freeform reply into:
  - `apply`
  - `skip`
  - `stop`
- optionally extract durable future guidance
- if applying:
  - ask the agent to make the code change
  - record history
- if skipping:
  - record why it was skipped
  - carry forward guidance
- then ask the agent for the **next** opportunity using:
  - original focus
  - accumulated guidance notes
  - prior reviewed/applied/skipped history
- either:
  - pause again on the next opportunity
  - or finish with a summary

#### Internal state model

`SimplifyState` stores:

- original prompt/focus
- accumulated notes
- current iteration number
- current opportunity
- history of reviewed opportunities

The procedure deliberately keeps the loop narrow:

- one opportunity at a time
- one freeform decision at a time
- history and notes feed the next scan

That prevents the agent from drifting into large speculative rewrites.

### `tests/unit/service.test.ts`

This file was extended with runtime-level coverage for the new pause model.

Added tests for:

- plain-text replies resuming a paused procedure
- explicit slash commands not consuming a pending continuation
- resumed sessions restoring paused continuations
- replay logs including paused runs

Also updated:

- replay normalization to include `run_paused`
- build-hook timeout from 15s to 30s, because the larger build made existing timeout-based hooks too tight

### `tests/unit/tui-controller.test.ts`

Added a test proving:

- `run_paused` re-enables input
- the status line reflects waiting for the user's reply
- the assistant's paused prompt is visible in the transcript

### `tests/unit/simplify-command.test.ts`

Added command-level coverage for `/simplify` itself:

- initial start pauses on a discovered opportunity
- redirecting feedback skips the current opportunity and carries guidance forward
- approving an opportunity applies it and pauses on the next one

### `tests/unit/mcp-server.test.ts`
### `tests/unit/default-memory-bridge.test.ts`

These did not need logic changes for the feature itself, but their build hook timeouts were increased from 15s to 30s because the repo build moved beyond the previous cap.

---

## User-visible behavior after the change

### Generic paused procedure behavior

Any harness procedure can now:

1. return a paused result with a question and durable state
2. wait for a normal user reply
3. resume using that reply
4. pause again or finish

Important routing rule:

- **plain text resumes**
- **explicit slash commands do not**

### `/simplify` behavior

Expected interaction:

1. `/simplify`
2. nanoboss proposes one simplification opportunity
3. nanoboss asks what to do
4. user replies in freeform language
5. nanoboss interprets that reply as:
   - apply current opportunity
   - skip current opportunity
   - stop the loop
   - redirect the search to a new area/category
6. nanoboss carries that intent into the next iteration

Examples of valid follow-ups:

- `apply it`
- `skip this one`
- `stop`
- `look for dead code instead`
- `focus on duplicate code`
- `avoid touching the session layer`

---

## Important design choices

### Chosen: durable state machine

This was explicitly implemented as persisted state plus `resume(...)`.

That is better than a live continuation loop because it:

- survives session restart
- fits the existing cell/session store model
- keeps replay and history coherent
- avoids needing a long-lived suspended JS call frame

### Chosen: open-ended replies are interpreted, not pattern matched

The user asked for something more open-ended than yes/no permission prompts.

So `/simplify` does **not** hardcode:

- yes/no
- apply/skip only

Instead it uses an interpretation step that maps freeform replies onto the loop actions and extracts future guidance.

### Chosen: slash commands should not consume pending continuations

This preserves CLI ergonomics:

- the user can inspect state or run another command
- the paused workflow remains pending
- they can return to it with a later plain-text reply

---

## Validation that was added

The implementation was exercised at several levels:

- runtime/service pause-resume behavior
- TUI paused-run behavior
- `/simplify` command behavior
- full repo lint/build/test

The final repo-wide run completed successfully with:

- `300 pass`
- `14 skip`
- `0 fail`

---

## Practical summary

If you want to understand the change quickly, the shortest accurate summary is:

1. nanoboss procedures can now **pause** and later **resume** from a persisted continuation state.
2. the service stores one pending continuation per session and routes the next plain-text reply back into it.
3. the TUI now understands a paused run as "waiting for your reply" instead of "still running".
4. `/simplify` is the first built-in procedure using that mechanism, with freeform user steering between iterations.

---

## Follow-up ideas

These were **not** required for the shipped change, but they are now unlocked:

- richer pause metadata in the UI
- explicit commands to inspect or clear pending continuations
- more procedures using `pause` / `resume`
- surfacing paused continuation state through more inspection tools
- allowing disk procedures and generated procedures to adopt the same loop pattern more easily
