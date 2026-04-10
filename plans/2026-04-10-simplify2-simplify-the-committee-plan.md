# Simplify2 focus-scoped research cache and focus picker plan

Date: 2026-04-10

## Status

Draft for review.

This supersedes the earlier "simplify the committee" draft by making one idea
central:

> the right simplification is to make `/simplify2` cache and resume research by
> **focus**, not to treat the repo-local artifacts as one global notebook.

The phase-count and checkpoint simplifications still matter, but they should now
be understood as consequences of this stronger focus model.

---

## Summary

Today, `/simplify2` already has the concept of a focus in its prompt parsing and
`focusHash`, but its durable storage is still mostly global:

```text
.nanoboss/simplify2/
  architecture-memory.json
  journal.json
  test-map.json
  observations.json
  analysis-cache.json
```

That means:

- `/simplify2 <focus A>` and `/simplify2 <focus B>` end up sharing one physical
  notebook
- old research from one seam can steer work on a different seam
- there is no first-class way for bare `/simplify2` to ask "which simplify line
  of thought do you want to continue?"
- the current foreground multi-iteration loop is partly compensating for the
  lack of a durable per-focus continuation model

The proposed simplification is to make **focus** the primary durable unit.

After this change:

- `/simplify2 <focus>` opens or creates a saved simplify focus
- research, memory, observations, and analysis caches are stored **per focus**
- bare `/simplify2` opens a focus picker
- the picker can continue, archive/delete, or start a new focus
- a focus can be continued even when there is no currently paused checkpoint,
  because the research cache itself is valuable
- `/simplify2` can become a more natural **one landed slice per invocation**
  tool, since the next invocation can cheaply reuse the same focus research

This is the main way to "simplify the committee" without giving up surgical
commits.

---

## Core problem

### 1. Simplify2 has a focus concept but not a focus-shaped storage model

The procedure parses focus text, stores focus-related state, and computes a
`focusHash`, but the durable artifacts under `.nanoboss/simplify2/` are shared
singletons.

So the code conceptually understands:

- focus A
- focus B
- cache reuse keyed by focus

but the filesystem and UX still feel like:

- one global simplify2 scratchpad for the whole repo

That mismatch is now large enough to matter.

### 2. Research and continuation are conflated

There are two valuable things simplify2 can preserve:

1. **research cache**
   - observations
   - memory
   - seam history
   - overlap suppression
   - test map and touched-file context
2. **paused continuation state**
   - specific checkpoint question
   - selected hypothesis
   - pending decision

The current system does preserve paused state through the session machinery, but
it does not make the research cache itself a first-class resumable object that
can be selected later by focus.

That makes bare `/simplify2` less useful than it should be.

### 3. The current multi-iteration loop is overworking one invocation

Because focus reuse across invocations is weak, simplify2 tries to do a lot in a
single foreground run:

- research
- propose
- apply
- reconcile
- commit
- immediately re-analyze again

This is one source of the "committee" feeling.

If focus-scoped caches become the durable center of gravity, then simplify2 can
more naturally:

- land one slice
- stop
- let the user come back later to the same focus
- resume from already-cached research instead of rebuilding a global notebook

### 4. Bare `/simplify2` has no good way to ask "what were we simplifying?"

A promptless invocation should be able to say:

- here are your saved simplify focuses
- which one do you want to continue?
- or do you want to start a new one?

That requires a focus index and a small amount of UI support.

---

## Goals

1. **Make focus the primary durable simplify2 unit**
   - research caches live under a stable focus identity
   - multiple simplify lines of thought can coexist in one repo

2. **Make bare `/simplify2` useful**
   - it should let the user choose an existing focus or start a new one

3. **Preserve surgical edits**
   - keep the careful apply/validate/commit behavior
   - keep human checkpoints where they add value

4. **Reduce the pressure to overwork one invocation**
   - prefer one landed slice per invocation
   - rely on focus reuse across invocations instead of eager immediate re-analysis

5. **Make the durable artifacts easier to reason about**
   - less global bleed-through between unrelated simplify campaigns
   - clearer memory files
   - easier cleanup/archive behavior

6. **Use better naming**
   - treat the user argument as a **focus**, not just a prompt blob

---

## Non-goals

- turning `/simplify2` into a generic one-shot `/simplify`
- inventing semantic nearest-neighbor matching for focus reuse in v1
- creating a totally generic procedure-owned picker framework on day one
- redesigning the repo-wide session architecture unrelated to simplify2
- changing the existing `nanoboss/commit` workflow

---

## Terminology

### Recommended term: focus

Use **focus** as the main product and code concept.

Why not `prompt`?

- the raw prompt is ephemeral user input
- the durable object we care about is the normalized simplification target
- a saved simplify line of thought is more than the original input text

Why not `area`?

- some targets are areas or subsystems
- many targets are conceptual seams or questions rather than directories or
  components
- "focus" is broad enough to include both

Recommended split:

- **raw prompt**: what the user typed
- **focus**: normalized durable target
- **title**: short human-readable label shown in the picker

Recommended user-facing help text:

```text
/simplify2 [focus]
```

Recommended input hint:

```text
Optional simplify focus; omit to choose a saved focus
```

---

## Proposed user experience

## 1. `/simplify2 <focus>`

Behavior:

1. normalize the supplied focus text
2. look for an exact normalized focus match in the local simplify2 index
3. if found, reopen that focus and reuse its cached research
4. if not found, create a new focus entry
5. run simplify2 against that focus
6. by default, land at most one slice and stop

Important property:

The user is not forced to remember session IDs or paused cells. They can return
by naming the same focus again.

### Example

```text
/simplify2 procedure metadata exposure rules
```

If that focus already exists, simplify2 reuses its prior research. If not, it
creates a new focus and starts building research for it.

---

## 2. Bare `/simplify2`

Behavior:

- if there are no saved focuses, ask for a new focus
- if there is exactly one unarchived focus, either:
  - continue it directly, or
  - show a tiny confirmation summary first
- if there are multiple saved focuses, show a focus picker

The picker should show enough context to answer:

- what is this focus about?
- is it paused on a checkpoint?
- how recently was it updated?
- what happened last?

Recommended visible fields in the picker:

- focus title
- status: `active`, `paused`, `finished`, `archived`
- last updated time
- last commit summary or last checkpoint summary
- maybe a short focus subtitle derived from the raw prompt

---

## 3. Continue semantics

Choosing a focus should mean:

- if that focus has a durable pending checkpoint, continue from it
- otherwise, continue from the saved research state and propose/apply the next
  slice

This distinction matters:

- **continuing a focus** is broader than **resuming a paused checkpoint**
- the cached research itself is valuable even when there is no pause waiting for
  a reply

---

## 4. Focus cleanup actions

The picker should support at least:

- **continue**
- **start new focus**
- **archive/delete focus**

Recommendation: use **archive** as the default semantics in v1.

Reasoning:

- archival is safer than hard delete
- it keeps a recovery path while still clearing clutter from the picker
- a later hard-delete command can physically remove archived focus dirs if
  needed

The UI can still say "delete" colloquially if that reads better, but the stored
semantics should be archive-first unless there is strong reason otherwise.

---

## Proposed data model

## A. Focus index

Introduce a small repo-local index:

```text
.nanoboss/simplify2/index.json
```

This file is the picker/catalog surface, not the full research cache.

Recommended shape:

```ts
interface Simplify2FocusIndexEntry {
  id: string;
  title: string;
  normalizedFocus: string;
  rawPrompt: string;
  createdAt: string;
  updatedAt: string;
  status: "active" | "paused" | "finished" | "archived";
  lastCheckpointQuestion?: string;
  lastCommitSummary?: string;
  lastTouchedFiles?: string[];
  pendingContinuation?: {
    question: string;
    sessionId?: string;
    cellId?: string;
    updatedAt: string;
  };
}
```

Notes:

- `normalizedFocus` is the lookup key for v1 reuse
- `title` is the short human-friendly picker label
- `pendingContinuation` is summary metadata for the picker, not necessarily the
  full canonical continuation blob

---

## B. Per-focus storage directory

Replace the singleton artifact layout with focus-scoped directories:

```text
.nanoboss/simplify2/
  index.json
  focuses/
    <focus-id>/
      focus.json
      architecture-memory.json
      journal.json
      test-map.json
      observations.json
      analysis-cache.json
      state.json
```

### `focus.json`

This is the canonical per-focus metadata file.

Suggested contents:

- focus ID
- title
- raw prompt
- normalized focus
- created/updated timestamps
- status
- optional summary of the last landed slice
- optional pending checkpoint summary

### `state.json`

This file should hold focus-local procedural state that is worth resuming across
sessions, independent of the current chat/session continuation mechanism.

This is the key step if we want focus continuation to be first-class rather than
only session-local.

---

## C. Separate research cache from paused continuation

Recommended model:

- **focus dir** holds canonical simplify2 research state
- **session metadata** may still hold the current UI continuation for the active
  chat session
- if there is a pending simplify2 checkpoint, the focus dir should also know
  about it in a durable way so a later bare `/simplify2` can offer to continue
  it

In other words:

- session pause remains a transport/UI convenience
- focus state becomes the durable simplify2 source of truth

That is the architectural shift that makes focus picking real.

---

## Normalization and matching

Start simple in v1.

### V1 matching rule

Reuse an existing focus only when the normalized focus matches exactly.

Possible normalization:

- trim whitespace
- lowercase
- collapse repeated internal spaces
- strip leading/trailing punctuation

Do **not** start with semantic matching.

Reasoning:

- exact normalized reuse is predictable
- semantic matching can mismerge two adjacent but distinct simplify themes
- the picker gives the user an explicit way to select the intended focus anyway

Possible later enhancement:

- if a new focus looks similar to an existing one, show a non-blocking suggestion
  rather than auto-merging

---

## How this simplifies the committee

The core committee problem is not just "too many phases". It is also that the
procedure lacks a durable per-focus continuation model, so it tries to do too
much inside one invocation.

Making focus first-class allows these simplifying behavior changes:

### 1. One landed slice per invocation becomes natural

Once research is cached per focus, simplify2 no longer needs to eagerly keep
thinking inside the same run.

Preferred default behavior:

1. open focus
2. reuse or refresh research
3. choose/apply one slice
4. validate and commit
5. update focus state
6. stop

The next invocation can cheaply continue from the same focus.

### 2. Memory stops bleeding across unrelated prompts

Research for:

- session metadata
- procedure metadata
- provenance/reflection

should not all live in one shared notebook.

Per-focus storage sharply reduces cross-contamination.

### 3. Bare `/simplify2` becomes the continuation UI

Instead of treating continuation as mostly "find the paused chat/session again",
users can treat simplify2 itself as the entrypoint for returning to unfinished
simplification work.

### 4. Phase collapse becomes a follow-on optimization, not the first move

Once focus reuse exists, simplify2 may still benefit from collapsing
architecture-refresh / observation / hypothesis phases. But that becomes a
second-order improvement rather than the main structural fix.

---

## UI plan

## A. Introduce a simplify2 focus picker UI

The current continuation UI model only knows about:

- simplify2 checkpoints with action buttons

We likely need a second simplify2-specific UI surface for focus selection.

Recommended new continuation UI kind:

```ts
interface Simplify2FocusPickerContinuationUi {
  kind: "simplify2_focus_picker";
  title: string;
  entries: Array<{
    id: string;
    title: string;
    subtitle?: string;
    status: "active" | "paused" | "finished" | "archived";
    updatedAt: string;
    lastSummary?: string;
  }>;
  actions: Array<
    | { id: "continue"; label: string }
    | { id: "archive"; label: string }
    | { id: "new"; label: string }
    | { id: "cancel"; label: string }
  >;
}
```

This can remain simplify2-specific at first; no need to invent a totally generic
list-picker framework yet.

---

## B. TUI behavior

Recommended TUI interactions for bare `/simplify2`:

- arrow keys or select overlay to choose a focus
- `enter` to continue
- `d` to archive/delete selected focus
- `n` to create a new focus
- `esc` to cancel

Displayed fields should include:

- title
- status badge
- relative updated time
- last checkpoint or commit summary

The TUI already has overlay/select patterns, so this should extend the current
simplify2 continuation UX rather than introducing a completely separate mental
model.

---

## C. CLI fallback

Non-TUI usage should still work.

Recommended CLI fallback:

- print a numbered list of focuses
- accept replies like:
  - `1`
  - `new <focus>`
  - `archive 2`
  - `stop`

This may be implemented through the same continuation/pause reply mechanism if
that is the cheapest host integration path.

---

## D. Rename prompt-shaped wording in the product surface

Update docs and hints from prompt-centric language toward focus-centric language.

Examples:

- `Optional focus or scope` -> `Optional simplify focus; omit to choose a saved focus`
- "prompt" in simplify2 docs -> "focus" where the durable concept is intended

Keep internal raw prompt fields where they still matter for provenance and exact
user input preservation.

---

## Execution model changes

## 1. Default to one landed slice per invocation

This should become the preferred default once focus-scoped caching exists.

Reasoning:

- the research is now reusable
- the user can return to the same focus cheaply
- review boundaries stay sharp
- simplify2 stops paying for the next idea before the current idea is reviewed

This means the earlier "simplify the committee" recommendation still stands, but
it now has a clearer structural justification.

## 2. Keep exact apply/validate/commit behavior initially

Do not loosen the surgical behavior just because focus handling changes.

Preserve:

- clean worktree requirement
- narrow `bun test` validation
- `nanoboss/commit` integration
- human checkpoints for clearly ambiguous cases

## 3. Defer major phase collapse until after focus storage lands

Once focus-scoped caching and picker UX exist, measure whether the remaining
latency still justifies collapsing architecture refresh, observation collection,
and hypothesis ranking into fewer child-agent calls.

This should be a follow-up optimization, not the first architectural move.

---

## Migration plan

## A. One-time import of legacy singleton artifacts

There will already be repos with:

```text
.nanoboss/simplify2/
  architecture-memory.json
  journal.json
  test-map.json
  observations.json
  analysis-cache.json
```

Recommended migration:

1. if `index.json` does not exist but legacy singleton files do exist,
2. create a synthetic imported focus,
3. derive its title from the old `architecture-memory.json.focus` if possible,
4. move or copy the singleton artifacts into `focuses/<legacy-id>/`,
5. write `index.json` with that one focus entry,
6. leave a small marker so migration is not repeated

Suggested fallback imported title:

- old `focus` field if non-empty
- otherwise `Imported legacy simplify2 focus`

---

## B. Backward-compatibility strategy

Short-term compatibility suggestions:

- keep accepting `/simplify2 <free text>` exactly as today
- continue parsing existing focus text naturally
- keep old iteration-budget text parsing temporarily if needed, but the new UX
  should emphasize focus selection over multi-iteration foreground loops

Open question:

- should `max N iterations` become deprecated once one-slice-per-invocation is
  the default, or should it remain as an explicit opt-in batch mode?

My bias is to keep parsing it for compatibility but de-emphasize it in docs.

---

## Suggested implementation phases

## Phase 1: establish focus as the storage unit

1. introduce `index.json`
2. create per-focus directories under `.nanoboss/simplify2/focuses/<id>/`
3. move simplify2 artifact helpers from singleton paths to focus-scoped paths
4. add legacy singleton migration
5. rename product/docs language from prompt -> focus where appropriate

### Success condition

`/simplify2 <focus>` creates or reopens a focus-specific cache directory instead
of writing into one global notebook.

---

## Phase 2: make bare `/simplify2` a focus picker

1. add a focus-listing path when no focus is supplied
2. add a simplify2-specific focus picker continuation UI
3. implement TUI selection support
4. implement CLI fallback replies
5. expose archive/delete behavior

### Success condition

Bare `/simplify2` can select and continue existing simplify focuses without
making the user remember old session IDs.

---

## Phase 3: move continuation semantics toward focus-local durability

1. persist focus-local resumable simplify2 state in `state.json`
2. surface pending checkpoint summaries in the focus index
3. allow continuing a focus even from a fresh session
4. keep session-local paused continuation as a transport/UI convenience

### Success condition

Choosing a focus from the picker can continue real simplify2 work, not merely
start over from a blank notebook.

---

## Phase 4: make one-slice-per-invocation the default simplify2 contract

1. stop automatic post-commit re-analysis
2. finish after a successful landed slice
3. rely on focus reuse for the next invocation
4. update docs/examples accordingly

### Success condition

Simplify2 remains surgical but no longer behaves like a foreground multi-commit
committee by default.

---

## Phase 5: optional follow-on simplifications

After focus-scoped caching is working, evaluate:

- collapsing the analysis front-half from 4 phases to 2 or 1
- tighter seam-diversity rules per focus
- trimming synthetic persisted observations more aggressively
- whether medium-risk checkpoints can be relaxed once the user is naturally back
  in the loop after each slice

These are still valuable, but they should follow the focus model work.

---

## Specific files likely to change

Primary simplify2 logic:

- `procedures/simplify2.ts`
- `docs/simplify2.md`

Likely type and continuation plumbing:

- `src/core/types.ts`
- `src/session/repository.ts`
- `src/http/frontend-events.ts`
- `src/procedure/runner.ts`

Likely TUI changes:

- `src/tui/app.ts`
- `src/tui/controller.ts`
- `src/tui/reducer.ts`
- `src/tui/state.ts`
- `src/tui/views.ts`
- `src/tui/overlays/*`

Potential shared storage helpers if extracted:

- `src/util/repo-artifacts.ts`
- new simplify2-specific artifact helpers if needed

---

## Success criteria

The plan is successful if all of the following become true:

1. `/simplify2 <focus A>` and `/simplify2 <focus B>` produce separate durable
   simplify2 research caches
2. bare `/simplify2` can list and continue saved focuses
3. saved focuses can be archived/deleted from the picker
4. simplify2 research continuity no longer depends primarily on remembering an
   old paused session
5. one landed slice per invocation becomes practical and natural
6. the `.nanoboss/simplify2/` layout is easier to inspect and clearly scoped by
   focus

Qualitatively, it should feel like:

- "simplify2 remembers what I was simplifying"
- "I can come back to an old simplify thread without spelunking session state"
- "the memory files belong to one simplify focus, not to the entire repo"
- "the tool still makes surgical commits, but it no longer tries to do
  everything in one long expensive run"

---

## Review questions

1. Should the default picker action be **continue selected focus**, with archive
   as a secondary action, or should the picker always ask for an explicit action
   mode first?
2. Should focus deletion in v1 be archive-only, or do you want true hard delete
   from the first iteration?
3. Should focus-local continuation become canonical immediately, or should v1
   only reuse research caches while leaving paused-checkpoint continuation tied
   to the original session?
4. Once focus reuse exists, do we want to formally de-emphasize `max N
   iterations`, or keep it as an advanced opt-in mode?
5. Do you want the docs and UI to say **focus**, or do you prefer a different
   user-facing noun such as **area** or **topic** even if the internal model is
   `focus`?
