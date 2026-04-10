# Simplify2 auto-commit, auto-approve, and continuation-card plan

Date: 2026-04-10

## Goal

Extend `/simplify2` so that:

- it refuses to start from a dirty worktree
- each successfully applied slice is committed automatically through the repo's existing `nanoboss/*` commit workflow
- the CLI can enable an auto-approve mode for simplify2 checkpoints
- the TUI shows the auto-approve state in the status/activity area
- paused simplify2 checkpoints become more transparent and more structured
- when auto-approve is off, paused simplify2 checkpoints can be handled through a focused continuation card with 1/2/3/4 actions

This should reuse the repo's existing `nanoboss/pre-commit-checks` and `nanoboss/commit` procedures rather than introducing a parallel git path.

---

## Product decisions

### 1. Clean worktree is a hard simplify2 precondition

`/simplify2` should fail fast when the worktree is dirty.

Reasoning:

- auto-commit after each slice becomes unsafe if preexisting unrelated edits are present
- simplify2 is a bounded refactoring loop, not a generic dirty-tree assistant
- the user explicitly wants this behavior

Recommended behavior:

- check cleanliness at the start of `execute(...)`
- also re-check at `resume(...)` before any branch that can apply or commit work
- if dirty, return a clear display message describing that simplify2 requires a clean worktree and showing `git status --porcelain` output

This second check on resume matters because a previously paused simplify2 session may be resumed after manual edits.

### 2. Auto-commit must reuse `nanoboss/commit`

Do not introduce a simplify2-specific git helper path for commit creation.

Reasoning:

- the repo already has a deliberate commit workflow
- `nanoboss/commit` already delegates to `nanoboss/pre-commit-checks`
- `nanoboss/pre-commit-checks` already owns the expensive-validation caching and replay behavior
- reusing those procedures keeps one source of truth for commit-time validation semantics

Recommended behavior:

- after a simplify2 slice applies and reconciles successfully, call `ctx.callProcedure("nanoboss/commit", commitContext)`
- do not call `nanoboss/pre-commit-checks` separately from simplify2; let `nanoboss/commit` own that dependency

### 3. Auto-approve is a TUI-local execution mode

The initial implementation should be local to the CLI/TUI, not persisted in session metadata and not generalized as a server-wide feature.

Reasoning:

- the feature is about local operator convenience in the interactive terminal
- the existing pause/resume model already routes plain-text replies back to the paused procedure
- keeping it local avoids adding mode state to session persistence before the UX has proven itself

Recommended behavior:

- add a CLI flag to start with simplify2 auto-approve enabled
- add a TUI keybinding to toggle it on/off during the session
- show the current state in the activity bar
- when a simplify2 checkpoint pauses and the mode is on, the TUI should immediately submit the approval reply back through the existing continuation path

### 4. Use a continuation card, not a generic procedure bar in v1

Do not invent a fully generic procedure-owned UI region yet.

Reasoning:

- the runtime only supports generic paused continuation metadata today
- a true procedure-owned live UI channel would require new core/runtime/event surface area
- the immediate need is specifically simplify2 paused-decision UX

Recommended behavior:

- add a simplify2-specific continuation card/overlay in the TUI for paused checkpoints
- keep the live mode indicator in the existing activity/status area
- defer a generalized "procedure bar" or procedure-owned live status region until there is a second concrete use case

---

## Current code constraints

### Simplify2 loop

The simplify2 execution and resume loop lives in:

- `procedures/simplify2.ts`

Relevant entry points:

- `execute(...)`
- `resume(...)`
- `continueFromAnalysis(...)`
- `applySimplificationSlice(...)`
- `validateAndReconcile(...)`
- `buildPausedResult(...)`

This is where clean-worktree gating, transparent proposal rendering, and post-apply auto-commit integration should land.

### Commit workflow

The repo-local commit workflow already exists in:

- `procedures/nanoboss/pre-commit-checks.ts`
- `procedures/nanoboss/commit.ts`

Important property:

- `nanoboss/commit` already calls `nanoboss/pre-commit-checks`, so simplify2 should compose only `nanoboss/commit`

### Pause and continuation plumbing

Paused procedure state currently supports:

- `question`
- `inputHint`
- `suggestedReplies`

The relevant plumbing is in:

- `src/core/types.ts`
- `src/procedure/runner.ts`
- `src/http/frontend-events.ts`
- `src/core/service.ts`
- `src/session/repository.ts`

### TUI

The interactive frontend already has:

- a status line
- an activity bar
- footer hints
- key handling for `esc`, `tab`, `ctrl+o`, `ctrl+c`
- an inline `SelectOverlay`

Relevant files:

- `src/tui/app.ts`
- `src/tui/controller.ts`
- `src/tui/state.ts`
- `src/tui/reducer.ts`
- `src/tui/views.ts`
- `src/tui/overlays/select-overlay.ts`

---

## Proposed implementation

## Workstream A: simplify2 clean-worktree gate

### Behavior

Before simplify2 does any analysis:

1. resolve the repo root
2. check whether the worktree is clean
3. if not clean, stop immediately with a human-readable error result

Before simplify2 resumes into any path that may apply or commit:

1. re-check whether the worktree is still clean
2. if not clean, stop and explain that the paused simplify2 run cannot continue until the tree is clean again

### Implementation direction

Add a small helper in `procedures/simplify2.ts` that:

- resolves the git repo root
- checks `git status --porcelain=v1 --untracked-files=all`
- throws or returns a structured early-finish result with the short status listing

The helper should run:

- at the start of `execute(...)`
- in `resume(...)` before `approve_hypothesis` handling
- also before any future auto-approve-driven apply path

### Why not rely on commit-time failure alone

If simplify2 is allowed to analyze and pause in a dirty tree, the later auto-commit path becomes ambiguous and the procedure's durable reasoning state no longer clearly maps to the exact code under review.

The clean-tree contract should be explicit and early.

---

## Workstream B: auto-commit after each applied slice

### Behavior

After a simplify2 slice:

1. apply the code change
2. run simplify2's own narrow validation and reconciliation
3. if validation failed, stop without commit
4. if validation passed, invoke `nanoboss/commit`
5. record the commit outcome in simplify2's display/journal state
6. continue to the next simplify2 iteration if budget remains

### Integration point

The best insertion point is after `validateAndReconcile(...)` and before the next analysis loop iteration.

That keeps the commit scoped to one completed simplify2 slice and avoids committing pre-reconciliation state.

### Commit context

Simplify2 should construct a concise commit intent string from:

- hypothesis title
- applied summary
- key conceptual change summary
- optionally a short note that this is one simplify2 slice

Example shape:

`commit the simplify2 slice "Canonicalize continuation parsing" based on the applied summary and reconciliation result; keep the message concise and focused on the conceptual simplification`

The goal is to give `nanoboss/commit` enough context to write a good commit message without sending it back into broad repo exploration.

### State additions

Add durable per-slice commit tracking to simplify2 state and/or latest-apply state:

- whether commit was attempted
- whether commit succeeded
- commit summary or sha when available

This should be included in:

- journal entries
- final display
- paused display lead for subsequent iterations when relevant

### Failure behavior

If `nanoboss/commit` fails after validation passed:

- stop the simplify2 run
- return a clear display explaining that the simplification applied successfully but the auto-commit step failed
- preserve enough detail for the user to recover manually

Do not silently continue to a later simplify2 iteration after commit failure.

### Important subtlety

Because `nanoboss/commit` reruns pre-commit validation through `nanoboss/pre-commit-checks`, simplify2 will effectively perform:

- narrow slice validation for conceptual correctness
- repo commit-time validation for workspace acceptance

That duplication is acceptable because they serve different purposes:

- simplify2 validation is scoped and immediate
- commit-time validation is the repo's canonical reusable gate with caching

---

## Workstream C: make simplify2 checkpoint output more transparent

### Goal

When simplify2 pauses, the user should see a scannable summary of:

- the current simplification proposal
- the competing hypotheses
- which hypothesis was selected and why

### Recommended output structure

Replace the current thin paused display with a deterministic host-rendered summary:

1. `I have a simplification proposal:`
   - title
   - short summary
   - kind / risk / score
   - scope files
   - why this reduces conceptual complexity

2. `I have proposed N hypotheses for this simplification:`
   - numbered or bulleted list
   - one line per hypothesis with title, kind, risk, score, and short scope

3. `I have selected hypothesis X:`
   - why it ranked highest
   - why it needs a checkpoint or is safe to apply
   - what it will concretely do

4. checkpoint question

5. available actions

### Implementation direction

Do not ask the model for extra prose.

Instead, render from the already-typed host data:

- `candidateHypotheses`
- ranking reason
- checkpoint reason
- implementation scope
- selected hypothesis fields

This keeps the output stable, cheap, and inspectable.

### Prompt changes

Only minor prompt tightening should be needed:

- preserve ranking reasons and checkpoint reasons
- make sure hypothesis summaries remain short and concrete enough for host rendering

The main work is display rendering, not model behavior.

---

## Workstream D: auto-approve CLI flag and TUI mode

### CLI surface

Add a new `nanoboss cli` flag such as:

- `--simplify2-auto-approve`

Behavior:

- starts the TUI with simplify2 auto-approve enabled
- only affects simplify2 paused checkpoints
- does not auto-approve other paused procedures in v1

Update help text accordingly.

### In-memory UI state

Add TUI state for:

- `simplify2AutoApprove: boolean`

This state is local to the running TUI session in v1.

### Toggle keybinding

Add a dedicated key chord to toggle the mode.

Recommendation:

- use `ctrl+y`

Reasoning:

- mnemonic for a YOLO-like mode
- low collision risk with ordinary typing
- safer than a plain letter key

### Activity/status indicator

Show the mode in the activity bar, for example:

- `simplify2 auto-approve on`
- `simplify2 auto-approve off`

The status line should also acknowledge toggles when the user flips the mode.

### Auto-approve behavior

When a `run_paused` event arrives for `/simplify2` and auto-approve is on:

1. let the paused state land in the UI
2. immediately submit the approval reply through the existing prompt path
3. keep the behavior debounced so one pause yields one approval send

Recommended approval reply:

- `approve it`

This keeps the implementation aligned with the current continuation interpreter.

### Scope guard

This mode should only auto-respond to `/simplify2`.

Do not auto-approve pauses from:

- `/simplify`
- `/autoresearch`
- `nanoboss/pre-commit-checks`
- other future procedures

That narrower scope keeps the feature understandable and reduces accidental approval of unrelated workflows.

---

## Workstream E: simplify2 continuation card for paused decisions

### Goal

When simplify2 pauses and auto-approve is off, the user should be able to answer from a focused card instead of manually typing freeform text.

### Menu behavior

The card should present:

- `1` continue
- `2` stop
- `3` focus on tests
- `4` something else

Expected reply mapping:

- `1` submits `approve it`
- `2` submits `stop`
- `3` submits `focus on tests instead`
- `4` switches into freeform entry mode and lets the user type a continuation reply

### UI model

Implement this as a simplify2-specific continuation card or overlay, not as a generic procedure-owned region.

Recommended UX:

- when simplify2 pauses and auto-approve is off, open the continuation card automatically
- the card becomes the focused composer region
- selecting `1`, `2`, or `3` submits immediately
- selecting `4` swaps to a small focused text-entry mode in the same card
- cancelling the card returns focus to the normal editor without clearing the pending continuation

### Why a card is better than only footer hints

- the action space is explicit
- number-key interaction is discoverable
- it keeps the approval surface visually tied to the paused simplify2 explanation
- it gives a clean place to host the `something else` text path

### Why not a generic procedure bar yet

A truly generic procedure-owned UI region would require:

- richer pause payload schema
- richer frontend events
- durable persistence of procedure UI state
- generalized rendering rules in the TUI

That is too large for this feature and not yet justified by the current codebase.

---

## Workstream F: pause payload shape for simplify2-only richer actions

### Current limitation

Paused continuation metadata today is only:

- question
- input hint
- suggested replies

That is not enough to describe:

- numbered actions
- a preferred default action
- a card title / detail sections

### Recommendation

Add an optional structured continuation-ui payload to `ProcedurePause`, but keep the first use narrow and backwards-compatible.

Suggested direction:

- extend `ProcedurePause`
- plumb through `PendingProcedureContinuation`
- expose it in `run_paused` and `continuation_updated`
- let the TUI ignore it for all other procedures

Possible shape:

```ts
continuationUi?: {
  kind: "simplify2_checkpoint";
  title: string;
  actions: Array<{
    id: "approve" | "stop" | "focus_tests" | "other";
    label: string;
    reply: string;
    description?: string;
  }>;
}
```

This is still generic enough to live in core types, but intentionally limited to paused-continuation UI metadata rather than arbitrary live procedure rendering.

### Why add this instead of deriving everything locally

The TUI should not have to guess whether:

- a paused simplify2 continuation wants a card
- which replies map to which actions
- what labels should be shown

The procedure should declare that shape explicitly.

---

## Workstream G: tests and docs

### Simplify2 tests

Add coverage for:

- dirty worktree blocks simplify2 execute
- dirty worktree blocks simplify2 resume/apply path
- successful simplify2 apply triggers `nanoboss/commit`
- commit failure stops simplify2 with a clear display
- paused output includes proposal summary, hypothesis list, and selected-hypothesis explanation

### TUI/controller tests

Add coverage for:

- CLI flag initializes simplify2 auto-approve mode
- toggle key flips the mode and updates status/activity text
- simplify2 pause with auto-approve on immediately forwards one approval reply
- simplify2 pause with auto-approve off opens the continuation card
- number-key actions send the expected replies
- `4` enters freeform mode and forwards typed text
- non-simplify2 paused procedures do not use the auto-approve path

### Service/core tests

If `ProcedurePause` is extended:

- add tests for round-tripping the new continuation UI payload through
  - cell persistence
  - session metadata persistence
  - frontend events
  - session restore

### Docs

Update:

- `docs/simplify2.md`
- CLI help text
- any relevant TUI help or procedure package docs if the pause payload shape changes

---

## File map

### Simplify2 behavior

- `procedures/simplify2.ts`
- `tests/unit/simplify2-command.test.ts`
- `docs/simplify2.md`

### Commit composition

- `procedures/nanoboss/commit.ts`
- possibly `tests/unit/pre-commit-checks.test.ts` if simplify2 composition coverage belongs there

### Pause payload plumbing

- `src/core/types.ts`
- `src/procedure/runner.ts`
- `src/http/frontend-events.ts`
- `src/core/service.ts`
- `src/session/repository.ts`

### CLI/TUI

- `src/options/frontend-connection.ts`
- `cli.ts`
- `src/tui/run.ts`
- `src/tui/app.ts`
- `src/tui/controller.ts`
- `src/tui/state.ts`
- `src/tui/reducer.ts`
- `src/tui/views.ts`
- new simplify2 continuation-card component under `src/tui/`
- tests under `tests/unit/tui-*.test.ts`

---

## Suggested implementation order

1. Add simplify2 clean-worktree gating.
2. Make simplify2 call `nanoboss/commit` after successful reconcile.
3. Add durable simplify2 commit status tracking and render it in output.
4. Improve simplify2 paused display transparency.
5. Add CLI flag and local TUI state for simplify2 auto-approve.
6. Add simplify2 pause metadata for the continuation card.
7. Implement the continuation card and key handling.
8. Add test coverage and documentation updates.

This order keeps the execution semantics correct before investing in the nicer paused UX.

---

## Non-goals for this change

- a fully generic procedure-owned live UI bar
- server-side persisted auto-approve mode
- auto-approval for procedures other than simplify2
- replacing the repo's existing `nanoboss/commit` and `nanoboss/pre-commit-checks` workflow
- removing simplify2's own narrow validation slice before commit-time validation

---

## Review points

The main design points worth reviewing before implementation are:

1. whether the new pause metadata should be core-generic now or whether the simplify2 card should derive from existing fields only
2. whether the continuation card should open automatically on every simplify2 pause or only when the user presses a key
3. the exact `ctrl+y` toggle choice for auto-approve
4. the exact commit-context string simplify2 should pass into `nanoboss/commit`
