# simplify2(7)

## NAME

`/simplify2` - bounded conceptual simplification loop for the current repository

## SYNOPSIS

```text
/simplify2 [focus text]
```

## DESCRIPTION

`/simplify2` is a built-in nanoboss procedure that looks for conceptual
simplifications in the current repository, applies small coherent slices when
the design is clear, and pauses for human input when the boundary is ambiguous.

Unlike `/simplify`, which asks the agent for one next opportunity at a time,
`/simplify2` runs a structured loop with durable state:

1. require a clean git worktree before starting
2. load inspectable simplify artifacts
3. refresh architecture memory for the current focus
4. collect typed observations
5. generate and rank hypotheses
6. choose one of:
   - pause for a checkpoint
   - apply one low-risk slice
   - finish because no worthwhile next slice stands out
7. after an apply, run a narrow validation slice, reconcile memory, auto-commit
   the finished slice through `nanoboss/commit`, and repeat

The current implementation uses a bounded foreground loop with a default budget
of 3 applied hypotheses per run.

If the worktree becomes dirty after a paused checkpoint, `/simplify2` stays
paused and refuses to continue the apply path until the tree is clean again.

## AUTO-COMMIT

Each successfully applied simplify2 slice is committed automatically through the
existing repo-local `nanoboss/commit` workflow. That means simplify2 keeps its
own narrow validation slice, then reuses the repo's canonical pre-commit checks
before creating the actual git commit.

If the simplify2 validation fails, no commit is attempted.

If the commit workflow fails, the simplify2 run stops and reports that failure
instead of continuing to another iteration.

## HUMAN CHECKPOINTS

`/simplify2` pauses when the top-ranked next slice is not obviously safe to apply.
Common pause cases:

- ownership or boundary changes
- design updates
- any non-low-risk hypothesis

Paused checkpoint output is rendered by the host from typed simplify2 state. It
shows the selected proposal, the competing hypotheses, why the chosen
hypothesis ranked highest, and the available actions.

In the TUI, paused simplify2 checkpoints also expose a focused continuation card:

- `1` continue
- `2` stop
- `3` focus on tests
- `4` something else

The CLI and TUI also support a local `--simplify2-auto-approve` mode, plus a
`ctrl+y` toggle, that auto-submits `approve it` for simplify2 checkpoints only.
## WHAT IT LOOKS FOR

`/simplify2` is generic across repositories, but it is not a single generic
"clean up the repo" prompt. It explicitly asks the downstream agent to look for:

- accidental concepts
- fake or overly split boundaries
- duplicated representations
- exceptions that should be removed
- test duplication and test smells
- architecture drift or design evolution signals

It separates those concerns into typed phases rather than asking for one freeform
proposal up front.

When paused, plain-text user replies are interpreted into one of these decisions:

- approve the current hypothesis
- reject the current hypothesis
- redirect the search
- revise the intended design
- stop

## FILESYSTEM ARTIFACTS

`/simplify2` keeps inspectable repo-local artifacts under:

```text
.nanoboss/simplify2/
```

Files:

- `architecture-memory.json`
- `journal.json`
- `test-map.json`
- `observations.json`
- `analysis-cache.json`

These files are intentionally local and are best-effort added to the repo-local
git exclude list so they do not show up as normal tracked changes.

## VALIDATION

After applying a slice, `/simplify2` selects a minimal trusted test slice based
on the selected hypothesis and inferred test map, then runs:

```text
bun test <selected test files>
```

If no trusted slice matches the scope, validation is recorded as skipped.

If validation fails, the current run stops and reports that failure instead of
continuing deeper into the loop.

## PROMPT SHAPE

The procedure uses several structured typed prompts rather than one monolithic
instruction:

- architecture refresh
- observation collection
- hypothesis generation
- hypothesis ranking
- human-reply interpretation
- apply-one-slice
- reconciliation after validation

That makes the command more inspectable and easier to steer than `/simplify`.

## EXAMPLES

General repo review:

```text
/simplify2
```

Focus on one subsystem:

```text
/simplify2 focus on session metadata ownership and paused continuation handling
```

Bias toward a smaller first slice:

```text
/simplify2 focus on continuation persistence; prefer a test or representation simplification before any boundary move
```

## OUTPUT

A run may:

- finish immediately if no worthwhile hypothesis stands out
- pause on a checkpoint question
- auto-apply a low-risk slice and continue into another analysis cycle
- stop after reaching the iteration budget

Finished output includes the latest applied slice, validation result, and counts
for applied and rejected hypotheses. When a slice was committed successfully,
the latest output also includes the commit status line for that slice.

## SEE ALSO

- [procedures/simplify2.ts](/Users/jflam/agentboss/workspaces/nanoboss/procedures/simplify2.ts)
- [procedures/simplify.ts](/Users/jflam/agentboss/workspaces/nanoboss/procedures/simplify.ts)
- [plans/2026-04-08-simplify-v2-procedure-pseudocode.md](/Users/jflam/agentboss/workspaces/nanoboss/plans/2026-04-08-simplify-v2-procedure-pseudocode.md)
