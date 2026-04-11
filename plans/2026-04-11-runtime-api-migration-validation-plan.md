# Runtime API migration validation plan

## Purpose

This plan defines how to judge whether the current runtime/procedure API migration tranche was successful.

This tranche intentionally added very little new end-user functionality. Its main goals were:

- expose the new named procedure-facing API on `ctx`
- add the first structured UI surface
- prove the new surface is usable by both humans and downstream agents

That means validation must cover more than green tests. It must answer three questions:

1. did we preserve existing behavior?
2. is the new API actually usable for authoring?
3. does the new API make follow-on work easier instead of harder?

## Source-of-truth constraints

This validation plan assumes the implementation goals and constraints from:

- `plans/2026-04-10-procedure-runtime-api-proposal.md`
- `plans/2026-04-11-runtime-api-migration-prep-refactor-plan.md`

In particular, validation must confirm that this pass:

- adds `ctx.agent`, `ctx.state`, `ctx.ui`, and `ctx.procedures`
- reserves `ctx.state` for durable runs/refs and `ctx.session` for live default-agent control
- does **not** add the CLI runtime adapter
- does **not** introduce the full Agent Runtime API yet

## Definition of success

The migration is successful if all of the following are true:

### 1. Named-surface success

New procedures can be written naturally against:

- `ctx.agent.run(...)`
- `ctx.state.runs.*`
- `ctx.state.refs.*`
- `ctx.ui.*`
- `ctx.procedures.run(...)`

without needing to fall back to compatibility shims.

### 2. UI semantics success

Structured UI emissions for:

- `info`
- `warning`
- `error`
- `status`
- `card`

survive the full stack:

- procedure context
- runtime event mapping
- replay persistence
- TUI rendering
- ACP/CLI-compatible streaming path

### 3. Agent-usability success

A coding agent can be asked to author or migrate a procedure using the new API and succeeds with little or no manual correction.

### 4. Extensibility success

A realistic next-step workflow can be described and at least partially implemented cleanly with the new API, and any remaining gaps are clearly due to missing surface area rather than confusing naming or hidden wiring.

## Validation tracks

## Track A: static and automated regression validation

This track proves the migration did not break existing behavior.

### A1. Full pre-commit pass

Run:

```sh
bun run check:precommit
```

Pass criteria:

- lint passes
- typecheck passes
- unit tests pass

### A2. Focused migration unit tests

These are the most directly relevant tests for this tranche.

Run:

```sh
bun test \
  tests/unit/context-api.test.ts \
  tests/unit/context-ui.test.ts \
  tests/unit/context-call-agent-session.test.ts \
  tests/unit/research-command.test.ts \
  tests/unit/knowledge-base-commands.test.ts \
  tests/unit/frontend-events.test.ts \
  tests/unit/acp-updates.test.ts \
  tests/unit/ui-cli.test.ts \
  tests/unit/tui-reducer.test.ts \
  tests/unit/tui-views.test.ts
```

What these cover:

- named API presence on `ctx`
- explicit state-vs-session contract
- new UI method emission behavior
- migrated procedure behavior
- structured UI event mapping and replay filtering
- TUI rendering of status/cards
- ACP/CLI marker parsing path

### A3. Broader procedure/runtime regression sweep

Run:

```sh
bun test \
  tests/unit/service.test.ts \
  tests/unit/default-history.test.ts \
  tests/unit/linter.test.ts \
  tests/unit/second-opinion-inherits-default-model.test.ts
```

Why:

- `service.test.ts` covers replay, session events, and runtime behavior
- `default-history.test.ts` validates default-session continuity while durable history stays under `ctx.state`
- `linter.test.ts` and `second-opinion` validate built-ins that depend on the surviving named runtime surface

### A4. End-to-end regression sweep

Run:

```sh
bun run test:e2e
```

Priority e2e tests to watch most closely:

- `tests/e2e/composition.test.ts`
- `tests/e2e/default-history-agents.test.ts`
- `tests/e2e/linter.test.ts`
- `tests/e2e/procedure-dispatch-recovery.test.ts`
- `tests/e2e/http-sse.test.ts`

Pass criteria:

- no regression in nested procedure composition
- no regression in default-session behavior
- no regression in replay/recovery paths
- no regression in frontend event delivery

## Track B: explicit namespace invariants

This track validates the non-negotiable runtime contract directly.

### B1. `ctx.state` owns durable data

Validation:

- inspect one existing procedure or direct unit test that uses `ctx.state.runs.*`
- confirm durable history/query access and refs are only reached through `ctx.state`

Acceptance:

- durable cells, traversal, and refs are grouped under `ctx.state`
- no runtime code or docs describe durable history as `ctx.session`

### B2. `ctx.session` owns live control

Validate these all still function:

- `ctx.session.getDefaultAgentConfig()`
- `ctx.session.setDefaultAgentSelection(...)`
- `ctx.session.getDefaultAgentTokenUsage()`

Acceptance:

- `ctx.session` refers only to live default-agent selection and usage for the current binding
- no traversal/history helpers are exposed on `ctx.session`

### B3. Durable session format remains compatible

Validation:

- resume/recovery tests still pass
- replay events from older runs still restore correctly
- no manual session migration step is required

Acceptance:

- no durable session breakage

## Track C: named API ergonomics validation

This track asks whether the new surface is actually nicer to use.

### C1. Human authoring spot check

Implement or review a tiny procedure using only the new surface.

Example target:

- one procedure that uses `ctx.agent.run(...)`
- one procedure that uses `ctx.procedures.run(...)`
- one procedure that uses `ctx.ui.status(...)` and `ctx.ui.card(...)`
- one procedure that uses `ctx.state.runs.latest(...)`

Acceptance:

- code reads naturally without needing knowledge of internal seams
- responsibilities are obvious from names
- no confusion between `ctx.state` and `ctx.session`

### C2. Generated-procedure authoring check

Use the built-in procedure generator or a coding agent prompt to create a new procedure from scratch.

Suggested tasks:

1. “Write a procedure that looks up the latest `/research` run and summarizes it using `ctx.state` and `ctx.ui.card`.”
2. “Write a procedure that calls one child procedure and one downstream agent using the new named API only.”

Acceptance:

- first draft typechecks, or needs only trivial fixes
- generated code primarily uses the named surface
- generated code does not incorrectly reach for hidden/internal APIs
- generated code treats `ctx.state` as durable data access and `ctx.session` as live control

Suggested metric:

- first-pass compile success rate across 5 runs
- number of manual edits required after generation
- whether the agent uses named APIs by default instead of shims

## Track D: structured UI path validation

This track validates that the new UI API is real, not just a type veneer.

### D1. Live emission path

For each method below, confirm that the event survives procedure -> runtime -> frontend mapping -> TUI:

- `ctx.ui.text(...)`
- `ctx.ui.info(...)`
- `ctx.ui.warning(...)`
- `ctx.ui.error(...)`
- `ctx.ui.status(...)`
- `ctx.ui.card(...)`

Acceptance:

- `text` produces streamed transcript text
- `info` / `warning` / `error` produce assistant-notice style behavior
- `status` updates the live run status without requiring text parsing conventions
- `card` renders as durable markdown-oriented assistant cards

### D2. Replay path

Start a run that emits `status` and `card`, then restore the session.

Acceptance:

- restored transcript contains replayable card/status semantics
- raw stored assistant text is not polluted by transport marker lines

### D3. ACP/CLI-compatible transport path

Validate that structured UI events survive through the text-based ACP/CLI path.

Acceptance:

- structured UI events can be encoded into a machine-readable text marker
- frontend event mapping recognizes and reconstructs them
- raw agent output collectors ignore those markers

## Track E: agent-usability validation

This is the most important qualitative track.

The question is not just “does the API exist?” but “can an agent understand how to use it correctly?”

### E1. Migration prompt test

Ask a coding agent to migrate a simple existing procedure from old API names to the new named surface.

Good candidates:

- `/research`
- `/kb/refresh`
- a small custom fixture procedure

Acceptance:

- the agent chooses `ctx.agent.run`, `ctx.ui.text`, or `ctx.procedures.run` correctly
- the resulting diff is minimal and behavior-preserving
- the agent does not try to rename `ctx.session` semantics in this pass

### E2. Greenfield prompt test

Ask a coding agent to write a new procedure against the named API with no hints about compatibility shims.

Example prompt:

> Write a procedure `/latest-research-summary` that finds the latest `research` run using `ctx.state.runs.latest`, loads the stored result via refs if needed, emits progress with `ctx.ui.status`, and publishes the summary as a `ctx.ui.card`.

Acceptance:

- the agent reaches for the named surface naturally
- the code compiles
- the implementation uses the API semantically rather than flattening back into `print()` everywhere

### E3. Constraint-awareness test

Ask a coding agent to do something that is near the edge of the current API.

Example:

> Build a live terminal preview for a long-running command using the new procedure UI API.

This is valuable because the correct result may be either:

- a working transcript-streaming prototype, or
- a clear statement that a dedicated live panel API is still missing

Both outcomes are useful if they reflect the actual runtime constraints.

## Track F: capstone validation - live terminal preview

## Why this is the right capstone

This API migration mostly changed naming and boundaries.

A good validation target should therefore test whether those new boundaries are expressive enough for a realistic workflow. A live terminal preview is a strong candidate because it needs:

- ongoing progress updates
- structured status
- durable summary/reporting
- a clean runtime/TUI rendering path
- clear understanding of what is and is not supported today

## The exact question to answer

Can a procedure author, especially an agent, use the new API to build a useful live terminal preview experience?

## Expected answer

### What is possible now

Yes, a useful first version is possible **now**.

A procedure can:

- emit `ctx.ui.status(...)` for high-level phase/status
- stream terminal output incrementally with `ctx.ui.text(...)`
- emit a final `ctx.ui.card(...)` with summary, output path, or next steps
- optionally persist the full raw output to a file and link/reference it in the final card

That would give a user a live, scrollable experience in the main transcript because the TUI transcript itself is scrollable.

### What is not possible yet

A dedicated, bounded, in-place-updating terminal region is **not** a first-class concept in the current API.

The current procedure UI surface does **not** yet have something like:

- `ctx.ui.terminal.open(...)`
- `ctx.ui.terminal.append(...)`
- `ctx.ui.region.update(...)`
- stable append/update semantics for a named scrollback panel

Current UI primitives behave like this:

- `text` = append to transcript
- `status` = replace/update status-line style state
- `card` = append durable markdown card

So if the desired UX is “a separate scrollable terminal pane/card with stable identity and full scrollback”, that likely needs a **new** UI surface rather than more work inside the current one.

## Capstone prototype scope

Build a prototype procedure with this contract:

### Procedure behavior

1. start a long-running child activity
2. emit `ctx.ui.status({ phase: "run", message: ... })`
3. stream stdout/stderr lines with `ctx.ui.text(...)`
4. on completion, emit a durable `ctx.ui.card(...)` summarizing:
   - command
   - exit status
   - path to saved full output
   - notable warnings/errors

### Acceptance criteria

- output appears live in the transcript while running
- transcript remains scrollable in the TUI
- final card renders as markdown
- the full output is recoverable after the run
- replay/restoration does not corrupt transcript text with transport markers

### Stretch criteria

Ask an agent to implement it from prompt only, using the new API.

Success if the agent either:

- implements the transcript-streaming version cleanly, or
- correctly explains that a separate live terminal region needs a new API surface

Failure if the agent:

- reaches for nonexistent hidden APIs
- confuses `card` with a mutable live region
- assumes `ctx.session` has already been repurposed

## Recommended validation order

1. run `bun run check:precommit`
2. run focused migration tests
3. run e2e regression suite
4. do one human-authored named-API spot check
5. do one migration-by-agent test
6. do one greenfield-by-agent test
7. do the live terminal preview capstone

## Exit criteria

We should consider this migration tranche validated when:

- automated regression tests are green
- no compatibility regressions are found
- at least one greenfield agent-authored procedure succeeds primarily with the new named surface
- at least one migration-by-agent succeeds with minimal correction
- the live terminal preview capstone either:
  - works as transcript-streaming UX, or
  - clearly exposes the next missing UI primitive needed for a dedicated live region

## Bottom line

The most important proof is not just that the tests pass.

The best validation is:

- existing procedures still behave the same
- new procedures are easier to write
- agents naturally use the new names correctly
- a realistic next-step workflow, like live terminal preview, is either enabled now or clearly bounded by one small missing UI primitive

That is how we will know the migration improved the authoring model rather than only renaming internals.
