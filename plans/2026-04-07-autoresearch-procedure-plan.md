# 2026-04-07 autoresearch procedure plan

## Summary

`pi-autoresearch` is an autonomous optimization loop for an agentic terminal workflow: define an objective and metric, establish a baseline, iteratively try changes, benchmark them, keep wins, revert regressions, and preserve enough structured state that a fresh agent can resume the work.

NanoBoss already has the core primitives needed to reproduce that behavior:

- slash-command procedures
- durable session state and refs
- resumable sessions
- async procedure dispatch
- agent delegation for planning and experiment selection

The missing pieces are mostly **deterministic host-side experiment control** and a **procedure set** that turns those primitives into a long-running optimization workflow. In NanoBoss, the control loop should live in TypeScript procedure code, not in a shell script. The first implementation should stay CLI-first and persistence-first; the custom dashboard/export surface can come later.

---

## What `pi-autoresearch` does

### Core loop

At a high level, `pi-autoresearch` runs this loop:

1. gather the optimization goal, metric, command, and file scope
2. create a dedicated working branch
3. write durable session artifacts and structured config
4. run a baseline benchmark
5. iterate autonomously:
   - propose a change
   - edit code
   - benchmark it
   - run optional backpressure checks
   - keep the change with a commit if it helps
   - revert it if it regresses or breaks checks
6. append every run to an experiment log
7. allow a fresh agent to resume from the log and session document
8. later, split kept improvements into reviewable branches

### Important behaviors to preserve

- **append-only run history**: `autoresearch.jsonl` is the source of truth for each experiment
- **human-readable session context**: `autoresearch.md` captures goals, tried ideas, wins, and dead ends
- **deterministic outer-loop control**: procedure code owns state transitions, branching, keep/revert, and resume
- **deterministic benchmark execution**: benchmark and checks should default to structured config executed by procedure code
- **branch isolation**: the loop works on an autoresearch branch, then finalization creates reviewable branches from the merge-base
- **resume after restart/context loss**: a new agent can continue from repo-local state
- **keep vs revert discipline**: failed or worse experiments do not accumulate
- **confidence awareness**: repeated measurements help distinguish real gains from noise

### Feature groups in `pi-autoresearch`

| pi-autoresearch piece | Responsibility |
| --- | --- |
| `autoresearch-create` skill | Collect goal/metric/scope, scaffold files, create branch, start loop |
| `init_experiment` | Persist one-time session configuration |
| `run_experiment` | Execute benchmark command, capture metric/output/timing |
| `log_experiment` | Append result history, commit kept wins, update UI/dashboard state |
| `/autoresearch` command | Start/resume/disable/clear/export workflow |
| `autoresearch-finalize` skill | Group kept wins into independent review branches |
| widget/dashboard/export | Live visibility into progress, best result, confidence, and run history |

---

## NanoBoss capabilities that map cleanly

### What already exists

- **procedures** can expose slash-command entrypoints and compose each other
- **`ctx.callAgent(...)`** can handle idea generation, ranking, and summaries
- **durable refs and session history** can persist machine-readable outputs between runs
- **session resume** already exists for restoring prior work
- **async procedure dispatch** can support long-running or resumable loops
- **existing plan/report writing patterns** already write Markdown artifacts into `plans/`

### What needs to be added

- deterministic local helpers for:
  - git branch setup / revert / commit selection
  - benchmark execution
  - metric parsing
  - append-only result logging
  - optional correctness checks
- procedure-level state model for active/inactive loop status
- a repo-local persistence format for cross-session resume
- procedure outputs that are small and machine-oriented, so later procedures can compose them

### Control-loop ownership

The most important adaptation from `pi-autoresearch` is this:

- in `pi-autoresearch`, shell artifacts help drive the workflow
- in NanoBoss, **procedures should drive the workflow**

That means:

- the outer loop lives in TypeScript
- benchmark/check execution should default to structured config, not shell
- shell scripts should be optional compatibility adapters only
- the agent provides experiment ideas and summaries, not loop control
- keep/revert, logging, and continuation decisions happen in deterministic code

The right NanoBoss equivalent is therefore not "write a shell loop and invoke it", but "write a procedure runner that repeatedly calls intelligence at controlled decision points."

---

## Recommended NanoBoss mapping

The cleanest mapping is **one user-facing controller plus a few focused support procedures**, with deterministic host-side helpers underneath.

Under this design, the procedure layer owns:

- reading and writing state
- deciding which step comes next
- invoking the agent for one bounded reasoning task
- invoking local benchmark/check helpers
- performing git keep/revert actions
- dispatching the next iteration

### Proposed procedure set

#### 1. `/autoresearch`

Primary entrypoint for start/resume/status-style usage.

Initial scope:

- `/autoresearch <goal text>`: create or resume a session
- if repo-local autoresearch state exists, treat prompt as continuation context
- if no state exists, gather missing details, scaffold files, create branch, run baseline

Responsibilities:

- discover or ask for:
  - optimization target
  - benchmark command
  - metric extraction rule
  - direction (`lower` or `higher`)
  - files in scope
- initialize repo-local state
- start or continue the autonomous loop
- return current best result, active branch, and state-file locations

#### 2. `/autoresearch-loop`

Internal or advanced procedure for the long-running experiment loop.

Responsibilities:

- propose next experiment
- apply candidate change
- run benchmark + optional checks
- decide keep/revert
- commit kept wins
- append experiment record
- update session document
- continue until stopped or iteration budget is reached

This is the best place to use async dispatch so the workflow is resumable instead of requiring one long foreground run.

Implementation-wise, this should be a deterministic runner in NanoBoss code, with an internal shape roughly like:

1. load state
2. ask the agent for the next experiment
3. apply the experiment
4. run benchmark helper
5. run checks helper if configured
6. evaluate keep/revert in code
7. persist state/log/doc updates
8. enqueue the next iteration if still active

#### 3. `/autoresearch-stop`

NanoBoss equivalent of `pi`’s `/autoresearch off`.

Responsibilities:

- mark the session inactive
- stop auto-continuation
- keep logs and session artifacts intact

#### 4. `/autoresearch-clear`

Reset procedure.

Responsibilities:

- delete or archive autoresearch state files
- clear active-loop markers
- optionally refuse if the worktree is dirty or branch state is unsafe

#### 5. `/autoresearch-finalize`

Review-branch creation procedure.

Responsibilities:

- read logged kept experiments
- group them into independent changesets
- show the proposed grouping
- create one branch per group from the merge-base
- preserve metric improvements in commit messages or branch summaries

#### 6. Optional later procedures

- `/autoresearch-status`: concise status-only view
- `/autoresearch-export`: write a static HTML/Markdown/JSON report rather than introducing a browser dashboard immediately
- `/autoresearch-confidence`: recompute or inspect noise/confidence details

---

## Tool-to-procedure mapping

| pi-autoresearch tool/skill | NanoBoss mapping | Notes |
| --- | --- | --- |
| `autoresearch-create` skill | `/autoresearch` start path | NanoBoss procedure can gather details directly instead of a separate skill package |
| `init_experiment` | deterministic helper used by `/autoresearch` | Better as local code than delegated agent behavior |
| `run_experiment` | deterministic helper called by `/autoresearch-loop` | Must own command execution, timing, timeout, and metric extraction |
| `log_experiment` | deterministic helper called by `/autoresearch-loop` | Should append JSONL, update summary doc, and return machine-readable result refs |
| `/autoresearch off` | `/autoresearch-stop` | Keep state, disable continuation |
| `/autoresearch clear` | `/autoresearch-clear` | Reset durable artifacts safely |
| `/autoresearch export` | later `/autoresearch-export` | Phase 1 can write report files before adding rich UI |
| `autoresearch-finalize` skill | `/autoresearch-finalize` | Strong fit for a procedure that combines agent reasoning with deterministic git work |

---

## State model and persistence

To preserve the strongest part of `pi-autoresearch`, NanoBoss should keep **repo-local state files** even though it also has session refs.

### Recommended repo-local artifacts

- `autoresearch.jsonl`
  - append-only run log
  - one record per experiment
  - includes metric, status, commit SHA when kept, description, and confidence metadata
- `autoresearch.md`
  - living objective and progress document
  - must be sufficient for a fresh agent to resume strategically
- `autoresearch.state.json`
  - active/inactive flag
  - branch name
  - iteration count
  - current best run id
  - benchmark config
  - checks config
  - metric config
  - files in scope

### Recommended benchmark/check config model

The plan should assume **no required shell artifact at all**.

Instead, `autoresearch.state.json` should hold a structured execution contract such as:

- benchmark:
  - `argv: string[]`
  - `cwd?: string`
  - `timeoutMs?: number`
  - `metric`:
    - `source: "stdout-regex" | "stderr-regex" | "exit-code" | "json-path"`
    - parser config
- checks:
  - zero or more command specs with their own `argv`, `cwd`, and `timeoutMs`

That gives NanoBoss deterministic execution without generating or trusting a shell script.

### When a script would still be acceptable

A generated script is only justified as a later escape hatch for workloads that genuinely need complex multi-step environment setup that cannot be expressed cleanly as structured command config.

That should be optional and explicitly second-class in the design, not the default contract.

### Why not rely only on NanoBoss session refs

Session refs are excellent for intra-session composition, but repo-local files still matter because they:

- survive fresh sessions and tool restarts
- remain inspectable outside NanoBoss
- align with the proven `pi-autoresearch` operating model
- provide a stable handoff surface for `/autoresearch-finalize`

The right design is therefore **repo-local state as source of truth**, with NanoBoss refs as acceleration and composition aids.

### Recommended code structure

The first implementation should explicitly separate deterministic orchestration from intelligence:

- `commands/autoresearch.ts`
  - user-facing entrypoint
- `commands/autoresearch-stop.ts`
  - stop command
- `commands/autoresearch-clear.ts`
  - reset command
- `commands/autoresearch-finalize.ts`
  - branch-splitting/finalization entrypoint
- `src/autoresearch/state.ts`
  - load/save state files
- `src/autoresearch/log.ts`
  - append/read JSONL records
- `src/autoresearch/benchmark.ts`
  - execute structured benchmark config and parse metrics
- `src/autoresearch/checks.ts`
  - run optional structured correctness checks
- `src/autoresearch/git.ts`
  - branch setup, revert, commit, merge-base helpers
- `src/autoresearch/runner.ts`
  - deterministic outer loop and state machine

This preserves NanoBoss's intended architecture: code runs the state machine, the model fills in bounded judgment calls.

---

## Loop design in NanoBoss terms

### Setup phase

1. validate git repository and working tree safety
2. create or switch to an autoresearch branch
3. gather benchmark configuration
4. write `autoresearch.md` and `autoresearch.state.json`
5. run baseline benchmark
6. append baseline to `autoresearch.jsonl`
7. dispatch `/autoresearch-loop`

### Iteration phase

Each loop iteration should:

1. read current state and best-so-far context
2. ask the agent for one scoped experiment idea
3. apply the code change
4. run the benchmark from structured config via deterministic procedure code
5. if benchmark passes, run optional checks from structured config via deterministic procedure code
6. compare result against the best-so-far and noise floor in code
7. if the result is a keep:
   - create a commit
   - append run record with kept status
   - update `autoresearch.md`
8. otherwise:
   - revert working-tree changes
   - append run record with rejected/failed status
   - update `autoresearch.md` with the failed idea
9. continue or stop based on explicit stop state, max iterations, or hard failure

The shell never decides whether to continue, keep, revert, or finalize; those transitions belong to the runner. In the preferred design, the loop does not require a shell artifact at all.

### Resume phase

Resume should come from repo-local state first:

1. inspect autoresearch state files
2. restore active branch and current best run
3. read recent experiment history
4. continue the loop via async dispatch

NanoBoss’s existing resumable sessions are useful, but they should not be the only recovery path.

---

## Scope recommendation for phase 1

Phase 1 should focus on the workflow core, not the UI polish.

### Include in phase 1

- `/autoresearch`
- `/autoresearch-loop`
- `/autoresearch-stop`
- `/autoresearch-clear`
- `/autoresearch-finalize`
- repo-local state files
- append-only JSONL logging
- baseline + keep/revert loop
- TypeScript runner/state-machine ownership of the loop
- structured benchmark/check config
- confidence calculation persisted in logs

### Defer until phase 2

- live widget in the TUI
- fullscreen dashboard overlay
- browser dashboard export with auto-refresh
- advanced grouping/visualization beyond what finalize needs

This keeps the first version aligned with NanoBoss’s current strengths: procedures, durable state, async dispatch, and agent orchestration.

---

## Safety rules

- never run the loop against an ambiguous or unsafe git state
- do not silently keep benchmark regressions
- make benchmark parsing explicit and deterministic
- do not make shell scripts part of the required control contract
- keep correctness checks separate from the optimization metric
- do not rely on transient chat memory for resumability
- stop or ask when branch/worktree state is ambiguous

---

## Tests to add

1. `/autoresearch` creates the expected state files and baseline log on first run.
2. `/autoresearch` resumes from existing repo-local state without reinitializing.
3. `/autoresearch-loop` reverts rejected experiments and keeps successful ones.
4. optional checks failures block keep decisions and are logged distinctly.
5. confidence metadata is persisted after sufficient runs.
6. `/autoresearch-stop` disables continuation without deleting history.
7. `/autoresearch-clear` resets state safely.
8. `/autoresearch-finalize` groups kept experiments into non-overlapping review branches.
9. loop resume after NanoBoss session restart still works from repo-local state alone.
10. the loop can run with no generated shell script at all.

---

## Implementation milestones

1. Define the repo-local state schema and structured benchmark/check contract.
2. Implement `src/autoresearch/*` helpers for benchmark execution, logging, git keep/revert, and state transitions.
3. Build the deterministic runner/state machine that owns loop transitions.
4. Build `/autoresearch` initialization and resume behavior on top of that runner.
5. Build `/autoresearch-loop` async continuation on top of persisted state.
6. Build `/autoresearch-stop` and `/autoresearch-clear`.
7. Build `/autoresearch-finalize`.
8. Add UI/reporting enhancements only after the core loop is reliable.

---

## Todo breakdown

1. Define the durable state files and JSONL record schema.
2. Design the benchmark/check contract so no shell artifact is required.
3. Implement the TypeScript runner/state machine and safe git behavior.
4. Implement entrypoint, stop, clear, and finalize procedures.
5. Add coverage for initialization, keep/revert behavior, resume, and finalization.
