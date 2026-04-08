# `/simplify2` repo trial scenario: session metadata and paused continuation ownership

This plan is a concrete trial scenario for exercising `/simplify2` against the current nanoboss repo.

The goal is not just to see whether `/simplify2` can propose any cleanup. The goal is to check whether it behaves like the new design intends:

- builds a model of the area first
- finds conceptual pressure rather than only textual duplication
- pauses when the design boundary may be real
- applies one coherent low-risk slice when the design is clear
- validates that slice with a narrow trusted test set
- leaves inspectable memory artifacts behind

---

## Why this repo area is a good trial

The session metadata / continuation path is a strong first real-world scenario because the same concept appears in several places with slightly different responsibilities:

- [src/session/repository.ts](/Users/jflam/agentboss/workspaces/nanoboss/src/session/repository.ts)
  This owns durable `SessionMetadata` persistence plus the workspace-scoped current-session index.
- [src/core/service.ts](/Users/jflam/agentboss/workspaces/nanoboss/src/core/service.ts)
  This constructs and persists `SessionMetadata`, carries `pendingProcedureContinuation`, and resolves plain-text replies back into paused procedures.
- [src/session/index.ts](/Users/jflam/agentboss/workspaces/nanoboss/src/session/index.ts)
  This re-exports the repository-facing surface.
- [tests/unit/current-session.test.ts](/Users/jflam/agentboss/workspaces/nanoboss/tests/unit/current-session.test.ts)
  This covers the current-session index behavior.
- [tests/unit/tui-controller.test.ts](/Users/jflam/agentboss/workspaces/nanoboss/tests/unit/tui-controller.test.ts)
  This covers the user-visible paused continuation flow.

That makes it a good fit for `/simplify2` because the command is supposed to ask questions like:

- is there one real owner of session metadata semantics
- is the current split between service and repository a real boundary or a fake one
- are tests preserving true invariants or just pinning current structure

---

## Trial prompt

Suggested prompt to run:

```text
/simplify2 focus on session metadata ownership, current-session persistence, and paused procedure continuation handling
```

A narrower follow-up if needed:

```text
/simplify2 focus on whether session metadata parsing and current-session index handling have a fake boundary
```

---

## What `/simplify2` should notice

A good run should gather observations roughly like these:

1. `SessionMetadata` is defined in one place, but its meaning is driven by behavior in more than one layer.

2. The service layer in [src/core/service.ts](/Users/jflam/agentboss/workspaces/nanoboss/src/core/service.ts) knows a lot about when session metadata should be persisted, updated, and cleared, while [src/session/repository.ts](/Users/jflam/agentboss/workspaces/nanoboss/src/session/repository.ts) parses and validates the stored shape.

3. Paused-procedure continuation behavior is user-visible in the TUI, but the persistence semantics for that continuation are tied back into session metadata writes in the service layer.

4. The tests are split by surface:
   [tests/unit/current-session.test.ts](/Users/jflam/agentboss/workspaces/nanoboss/tests/unit/current-session.test.ts) covers the index and parsing rules, while [tests/unit/tui-controller.test.ts](/Users/jflam/agentboss/workspaces/nanoboss/tests/unit/tui-controller.test.ts) covers the resumed UX.
   A good simplifier should ask whether any tests pin accidental structure rather than the invariant.

5. The current boundary may be ambiguous rather than obviously wrong.
   That is exactly the sort of case where `/simplify2` should checkpoint instead of pretending the answer is obvious.

---

## Likely hypotheses a good run should produce

The exact wording can vary, but the strongest hypotheses should be in this neighborhood.

### Hypothesis A: centralize metadata ownership

`/simplify2` may conclude that the service layer is doing too much metadata-shape orchestration and that one narrower owner should define update semantics for `SessionMetadata`.

Possible title:

```text
Centralize session metadata update semantics behind one repository-facing operation
```

Expected shape:

- kind: `centralize_invariant` or `collapse_boundary`
- risk: medium
- checkpoint likely required

### Hypothesis B: keep the boundary, simplify tests

`/simplify2` may conclude that the service/repository split is real enough, but the tests around paused continuation and current-session behavior duplicate setup or document the structure too directly.

Possible title:

```text
Simplify duplicated continuation persistence test setup while preserving session metadata invariants
```

Expected shape:

- kind: `simplify_tests`
- risk: low or medium
- may be the best first apply slice

### Hypothesis C: canonicalize continuation persistence language

`/simplify2` may find that the same paused-continuation concept is represented with slightly different framing in service, persistence, and UI-facing code.

Possible title:

```text
Canonicalize paused continuation persistence semantics across service and repository
```

Expected shape:

- kind: `canonicalize_representation`
- risk: medium
- may need a checkpoint if it changes real ownership

---

## Expected checkpoint behavior

This is the most important part of the trial.

A good `/simplify2` run should not jump straight into moving session responsibilities unless it can justify that the boundary is fake. It should likely pause with a question roughly like:

```text
The service layer and repository both appear to participate in session metadata ownership.
Do you want me to collapse that boundary, or is the repository intentionally only a storage/parser layer while the service remains the semantic owner?
```

Good approval responses:

- `yes, centralize the metadata ownership if it keeps public behavior unchanged`
- `simplify the tests first but do not move the ownership boundary yet`

Good rejection / design-update responses:

- `the boundary is real: the repository should stay dumb and the service should own semantics`
- `keep the current split but remove duplicated tests or redundant translation`

If `/simplify2` applies a structural ownership change without first pausing on that question, that is a bad sign for this scenario.

---

## What a good first applied slice looks like

The best v1 slice here is probably not a broad architectural rewrite. It is likely one of these:

1. A test-focused simplification slice.
   Example: reduce duplicate setup or duplicate assertions around paused continuation persistence, while preserving the real invariant checks.

2. A narrow canonicalization slice.
   Example: centralize one repeated session-metadata update pattern or one repeated continuation-state translation path without changing the overall service/repository split.

3. A narrow repository-surface cleanup.
   Example: introduce one clearer repository-facing helper that represents the true invariant already present in the code, while deleting redundant ad hoc handling.

The first slice should not do all of the following at once:

- redesign session persistence
- change TUI continuation UX
- rewrite the session store
- move multiple responsibilities across layers

If the proposed change starts to touch unrelated session machinery, the slice is too broad.

---

## Trusted validation slice

For this scenario, `/simplify2` should prefer a small validation set centered on the semantics it touched.

The expected minimal trusted slice is:

- [tests/unit/current-session.test.ts](/Users/jflam/agentboss/workspaces/nanoboss/tests/unit/current-session.test.ts)
- the paused-continuation coverage in [tests/unit/tui-controller.test.ts](/Users/jflam/agentboss/workspaces/nanoboss/tests/unit/tui-controller.test.ts)

If the applied slice only touches repository parsing or the current-session index, then running only [tests/unit/current-session.test.ts](/Users/jflam/agentboss/workspaces/nanoboss/tests/unit/current-session.test.ts) may be enough.

If it touches paused continuation semantics or how plain-text replies get routed back into procedures, the TUI controller slice should also be included.

---

## What success looks like

This trial is successful if `/simplify2` does most of the following:

1. It identifies the session metadata / continuation area as a conceptual boundary question rather than just a search for duplicate lines.

2. It pauses before changing ownership semantics if that boundary is ambiguous.

3. It can accept a typed design update like:
   `the repository is intentionally storage-oriented; keep semantics in the service layer`
   and then redirect toward a smaller test or representation simplification.

4. If it applies a slice, the slice is small, coherent, and easy to inspect.

5. It selects a narrow validation set rather than falling back to a broad repo-wide test run.

6. It leaves `.nanoboss/simplify2/` artifacts that make the reasoning path inspectable after the run.

---

## What failure looks like

This trial is a failure signal if `/simplify2` does any of the following:

- proposes a broad “clean up sessions” rewrite with no sharp semantic center
- changes service/repository ownership without asking whether the boundary is real
- optimizes around file-level duplication while missing the ownership question
- picks a very large unrelated validation set
- proposes wrapper-heavy changes that preserve all current surfaces instead of collapsing one concept

---

## Review checklist before trying it

Before running the scenario, the human reviewer should answer these:

1. Is the service/repository split here intended, or are you open to collapsing it if a smaller model emerges?

2. Are you more interested in:
   - simplifying ownership semantics
   - simplifying test structure
   - simplifying terminology / representation

3. Do you want `/simplify2` to be allowed to touch TUI-facing continuation behavior in the same slice, or should it stay in persistence/service code only?

My recommendation for the first live try:

```text
/simplify2 focus on session metadata ownership, current-session persistence, and paused procedure continuation handling; prefer a test or representation simplification before any large boundary move
```

That keeps the first run honest: it still has to model the architecture, but it is biased toward a v1-sized slice rather than an architectural rewrite.
