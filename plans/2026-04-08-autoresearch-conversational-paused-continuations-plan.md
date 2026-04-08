# Simplify `/autoresearch*` onto paused continuations

## Problem

`/simplify` now demonstrates the intended nanoboss procedure model: one top-level command can pause, ask an open-ended follow-up, and resume later from durable state. `/autoresearch*` still exposes an older explicit command family (`/autoresearch/start`, `/autoresearch/continue`, `/autoresearch/status`, `/autoresearch/clear`, `/autoresearch/finalize`) with its own repo-local continuation model. That split makes autoresearch feel more operational than conversational, and it misses the new pause/resume UX that the runtime now supports.

The goal is to simplify the user experience so `/autoresearch` becomes the main conversational entrypoint while preserving the repo-local state, logs, branch management, and finalize flow that autoresearch already depends on.

## User story

As a user who wants to optimize unit test performance for maximum parallelism, I can start with a single prompt such as:

`/autoresearch optimize unit test performance for maximum parallelism`

Nanoboss should then:

1. Inspect the repo and configure a safe autoresearch session for this goal.
2. Establish a baseline benchmark and any relevant validation checks.
3. Propose one concrete experiment at a time, such as:
   - increasing per-file parallelism
   - splitting slow suites
   - reducing shared setup bottlenecks
   - removing serialization points in the test harness
4. Ask me what to do next in natural language.

Example interaction:

1. `/autoresearch optimize unit test performance for maximum parallelism`
2. Nanoboss creates the repo-local session, runs the baseline, and pauses with a first candidate plus a question like "Apply this experiment, skip it, refine the goal, inspect status, or stop?"
3. I reply with freeform guidance such as:
   - `apply it`
   - `skip this one and focus on test sharding first`
   - `avoid touching the session layer`
   - `show me current status`
   - `stop here and finalize kept wins`
4. Nanoboss resumes the same top-level procedure, keeps the repo-local state and experiment history, and either pauses again on the next decision or finishes cleanly.
5. If I run an unrelated slash command in the middle, the autoresearch continuation remains pending and I can return to it with a later plain-text reply.

This should make autoresearch feel like a guided optimization loop instead of a set of separate operational commands, while still retaining durable repo-local artifacts for later inspection and review.

## Proposed approach

Keep the existing repo-local autoresearch state machine as the durable source of truth, but layer the new session-level paused continuation UX on top of it.

In practice:

1. Make `/autoresearch` the main conversational procedure with `execute(...)` and `resume(...)`.
2. Reuse the existing repo-local artifacts in `.nanoboss/autoresearch/` for branch state, experiment logs, summaries, and finalize behavior.
3. Refactor the current runner so "start one session", "run one bounded step", "inspect status", "clear", and "finalize" are shared primitives instead of being tightly coupled to separate command entrypoints.
4. Return real `pause` payloads after meaningful decision points instead of instructing the user to manually call `/autoresearch/continue`.
5. Preserve `/autoresearch/start`, `/autoresearch/continue`, `/autoresearch/status`, `/autoresearch/clear`, and `/autoresearch/finalize` as compatibility and operational surfaces, but make them thin wrappers around the same shared logic.

## Todos

1. **Define conversational contract**
   - Decide the revised top-level `/autoresearch` UX, including what question is shown after baseline, after each experiment, after dirty-worktree interruption, and at stop/finalize boundaries.
   - Define which freeform user replies should map to apply, skip, stop, status, finalize, and refinement actions.

2. **Extract shared autoresearch primitives**
   - Refactor `procedures/autoresearch/runner.ts` so session initialization, branch preparation, one-step experiment execution, status rendering, clear, and finalize can be called from both compatibility commands and the new paused procedure.

3. **Implement paused `/autoresearch`**
   - Replace the current overview-only `/autoresearch` with a real `execute(...)` + `resume(...)` procedure.
   - Persist only lightweight continuation state in the session pause payload; continue using repo-local autoresearch files as the canonical experiment state.

4. **Align interruption and recovery handling**
   - Convert current "paused" or "manual follow-up needed" cases, especially dirty-worktree and branch-preparation handoffs, into first-class paused procedure results where appropriate.
   - Keep explicit slash commands from consuming a pending autoresearch continuation.

5. **Preserve compatibility command surface**
   - Keep `/autoresearch/start`, `/autoresearch/continue`, `/autoresearch/status`, `/autoresearch/clear`, and `/autoresearch/finalize` working, but route them through the refactored shared logic so behavior stays consistent.

6. **Add focused coverage**
   - Add command- and service-level tests for paused autoresearch start/resume flows, slash-command coexistence, session restore behavior, and compatibility wrappers.
   - Update any user-facing descriptions or help text that currently describe autoresearch as an explicit-command-only workflow.

## Notes and considerations

- The repo-local autoresearch files should remain the durable source of truth for experiment history and review workflow; the session pause payload should only hold enough state to resume the conversation safely.
- `/autoresearch` should pause at natural decision boundaries rather than trying to keep a long unbroken foreground loop running.
- `/autoresearch/status`, `/autoresearch/clear`, and `/autoresearch/finalize` are still useful even after the conversational flow exists, especially for recovery and operator-style control.
- The new UX should mirror `/simplify` where possible, but autoresearch needs a richer action vocabulary because it can refine goals, inspect progress, and finalize accumulated wins.
