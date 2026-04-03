# 2026-04-03 ACP tool-call cards alignment plan

## Goal

Make nanoboss render ACP tool-call notifications as individual **tool cards** in the pi-tui UI, aligned with how `~/src/pi-mono` renders tool calls in its interactive mode.

The target is alignment in **presentation model and lifecycle**, not a literal code copy:

- one visible card per meaningful tool call
- card created when the tool starts
- card updated while the tool is running
- card finalized with success/error styling and result preview
- cards remain part of the transcript for the turn instead of flashing by as ephemeral status lines

---

## Current nanoboss behavior

Today nanoboss maps ACP tool notifications into lightweight frontend events and then renders them as simple activity lines.

### Current flow

- `src/frontend-events.ts`
  - maps ACP `tool_call` -> `tool_started`
  - maps ACP `tool_call_update` -> `tool_updated`
- `src/tui/reducer.ts`
  - stores them in `UiToolCall[]`
- `src/tui/views.ts`
  - renders them in the `activity` section as indented lines like `[tool] ...`
- `src/tui/reducer.ts`
  - clears tool calls on `run_completed` / `run_failed`

### Current limitations

1. **Tool calls are not cards**
   - they render as plain text lines
   - no boxed/backgrounded visual identity

2. **Tool calls are ephemeral**
   - they disappear at run end
   - they do not become part of the retained transcript

3. **Payload is too thin for pi-mono-style rendering**
   - frontend events carry `title`, `kind`, `status`
   - they do not carry bounded call/result previews suitable for card bodies

4. **Nested/default-session progress currently drops result payloads**
   - `src/procedure-dispatch-progress.ts` strips `rawOutput`
   - that prevents rich completion cards for bridged async/default-session tool activity

---

## What pi-mono is doing today

The closest reference is the coding-agent interactive mode in `~/src/pi-mono`.

### Relevant files

- `packages/coding-agent/src/modes/interactive/components/tool-execution.ts`
  - shared card container for tool execution
  - pending/success/error backgrounds
  - card persists and updates over the tool lifecycle
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
  - inserts tool cards directly into the chat container on tool start
  - updates the same component on streaming updates / completion
- `packages/coding-agent/src/core/tools/*.ts`
  - per-tool `renderCall(...)` and `renderResult(...)`
  - these are what make `bash`, `read`, `edit`, `write`, etc. look polished

### Important architectural pattern

pi-mono has **two layers**:

1. a generic **tool card shell**
2. optional **tool-specific renderers**

That is the right shape to copy conceptually.

Nanoboss should not try to port pi-mono's coding-agent runtime wholesale. It should adopt the same separation:

- generic card lifecycle + styling in nanoboss TUI
- optional known-tool formatting for tools whose ACP payloads are structured enough
- generic fallback rendering for everything else

---

## Recommendation

Implement this as a **frontend event + TUI state/view refactor**, not as a cosmetic tweak to the existing activity lines.

### Recommended UX end state

- tool calls render inline with the conversation as cards
- cards are created on `tool_call`
- cards are updated on `tool_call_update`
- completed cards stay visible after the run finishes
- prompt diagnostics / memory-card notices / heartbeats can remain in the lighter-weight activity/status areas
- internal wrapper noise can still be suppressed/collapsed where appropriate

### Non-goal

Do **not** attempt to import or depend on pi-mono's coding-agent UI internals. Nanoboss should stay on `@mariozechner/pi-tui` plus local app code.

---

## Proposed implementation plan

## Phase 1: Enrich frontend tool events with bounded card data

### Why

Current `tool_started` / `tool_updated` events do not carry enough information to render meaningful cards.

### Recommendation

Extend frontend events so they carry **compact, bounded summaries**, not raw unbounded payloads.

### Proposed event shape direction

Keep the existing event names, but enrich them.

For `tool_started`:

- `toolCallId`
- `title`
- `kind`
- `status`
- `inputSummary?`
- `displayTitle?` if we want to separate a raw ACP title from a normalized card title

For `tool_updated`:

- `toolCallId`
- `title?`
- `status`
- `outputSummary?`
- `errorSummary?`
- `durationMs?`
- token usage remains separate as today

### Do not forward full raw payloads by default

Do **not** blindly pipe ACP `rawInput` / `rawOutput` into SSE history and TUI state.

Reasons:

- `read` / `bash` results can be large
- `SessionEventLog` history would bloat
- replay over SSE would get noisy and expensive

Instead, add a summarization helper in `src/frontend-events.ts` that converts ACP payloads into compact preview strings or tiny structured previews.

### Files likely involved

- `src/frontend-events.ts`
- `tests/unit/frontend-events.test.ts`

---

## Phase 2: Preserve compact tool payloads through async/default-session bridging

### Why

Today `src/procedure-dispatch-progress.ts` preserves tool start info, but strips `rawOutput` entirely for bridged `tool_call_update` events.

That means the frontend cannot build completed result cards for many nested/default-session flows.

### Recommendation

Change the bridge to preserve the same **bounded tool preview fields** introduced in Phase 1.

Do not keep the full raw output; keep only the compact card-safe representation.

### Likely change

Move tool preview summarization earlier, then serialize only:

- title
- status
- compact input preview
- compact output/error preview
- maybe duration/token info if useful

### Files likely involved

- `src/procedure-dispatch-progress.ts`
- possibly `src/service.ts` if a helper wants to run there instead of in the frontend-event mapper

---

## Phase 3: Replace ephemeral `toolCalls[]` with persistent transcript-level tool cards

### Why

The current `UiToolCall[]` model is built for a temporary activity gutter, not for pi-mono-style retained cards.

### Recommendation

Refactor the UI state so tool cards are transcript items, not a transient side list.

### Suggested state direction

Either:

```ts
interface UiToolCard {
  id: string;
  runId: string;
  title: string;
  kind: string;
  status: string;
  depth: number;
  isWrapper: boolean;
  inputSummary?: string;
  outputSummary?: string;
  errorSummary?: string;
}
```

and then store them in a transcript item union such as:

```ts
type UiTranscriptItem =
  | { type: "turn"; turn: UiTurn }
  | { type: "tool_card"; card: UiToolCard };
```

Or keep separate arrays/maps internally but render them as transcript items.

### Key behavior change

Completed tool cards should **not** be cleared on `run_completed`.

That is necessary if we want the same feel as pi-mono.

### Keep existing suppression logic

Nanoboss already hides/collapses wrapper-ish tool titles such as:

- `callAgent...`
- `defaultSession:...`
- `procedure_dispatch_wait`

That behavior should remain initially, otherwise the UI will fill with orchestration plumbing instead of meaningful leaf work.

### Files likely involved

- `src/tui/state.ts`
- `src/tui/reducer.ts`
- `tests/unit/tui-reducer.test.ts`

---

## Phase 4: Render actual card components in pi-tui

### Recommendation

Add a dedicated tool-card view/component instead of formatting cards as big strings inside `views.ts`.

### Suggested new files

```text
src/tui/components/tool-card.ts
src/tui/components/tool-card-format.ts
```

### Component responsibilities

- render pending/success/error background treatment
- render a title/header row
- render optional body sections:
  - call/input preview
  - result preview
  - error preview
- support nested indentation/depth
- gracefully render nothing when a suppressed wrapper branch should stay hidden

### pi-mono alignment to copy

The visual metaphor to copy from pi-mono is:

- a distinct boxed/backgrounded region
- concise header
- compact result body
- status implied by color/state

### pi-tui requirements

Nanoboss will likely need to re-export more pi-tui primitives from `src/tui/pi-tui.ts`, probably at least:

- `Box`
- maybe additional layout primitives if needed

### Theme work

Add tool-card colors to `src/tui/theme.ts`, roughly analogous to pi-mono's:

- pending bg
- success bg
- error bg
- tool title color
- tool body/output color

---

## Phase 5: Move tool rendering out of `activity` and into transcript flow

### Recommendation

Tool cards should appear in the same scrolling transcript region as user/assistant turns.

That is a more faithful match to pi-mono than keeping them in the separate `activity` block.

### What should stay outside the transcript

These can remain ephemeral:

- status line
- run heartbeat text
- prompt diagnostics
- memory-card injection notices

### What should move into the transcript

- per-tool start/progress/completion cards
- final error state for tool failures

### Likely view behavior

`appendTranscript()` should render turns plus any tool cards belonging to the current/past run in order.

`appendPendingActivity()` should shrink to non-tool diagnostics.

### Files likely involved

- `src/tui/views.ts`
- `tests/unit/tui-views.test.ts`

---

## Phase 6: Add a generic renderer first, then known-tool polish

### Recommendation

Do this in two steps.

### Step 1: generic fallback card

For all ACP tools, render:

- title
- compact args/input preview
- compact output preview or error text

This gets nanoboss to the right interaction model quickly.

### Step 2: known-tool formatting

For recognizable tools, make the card body resemble pi-mono more closely.

Likely initial targets:

- `bash`
- `read`
- `edit`
- `write`
- `find`
- `grep`
- `ls`

### Constraint

ACP does not always expose the same structured tool metadata pi-mono has internally.

Because of that, exact parity for every external agent/tool is unrealistic.

The right goal is:

- **identical card lifecycle**
- **very similar visual treatment**
- **best-effort formatting for known tools**
- **clean generic fallback for unknown tools**

---

## Phase 7: Preserve existing flags and semantics

### `--no-tool-calls`

Keep `--no-tool-calls` working.

Recommended behavior:

- when enabled: no tool cards rendered
- status line + assistant text still work as today

### Wrapper suppression

Keep the existing wrapper suppression/collapse rules at first.

That means the initial aligned UI should emphasize:

- real file/tool work
- not nanoboss orchestration internals

This will make the output feel closer to pi-mono's user-facing tool cards.

---

## Phase 8: Testing plan

## Unit tests

### `tests/unit/frontend-events.test.ts`

Add coverage for:

- tool start event includes compact input preview
- tool update completed includes output preview
- tool update failed includes error preview
- previews are truncated/bounded

### `tests/unit/tui-reducer.test.ts`

Add coverage for:

- tool start creates a transcript-level card
- tool update mutates the same card
- completed cards persist after run completion
- wrapper suppression still works
- out-of-order update can synthesize/update a placeholder card safely

### `tests/unit/tui-views.test.ts`

Add coverage for:

- cards render in transcript order
- pending/success/error states are visually distinguishable
- `activity` area no longer owns tool rendering

## E2E / integration coverage

Use the mock-agent-backed SSE path to verify:

- tool start/update notifications produce retained cards
- nested/default-session tool progress still renders cards after the bridge
- `--no-tool-calls` suppresses them

Likely files:

- `tests/e2e/http-sse.test.ts`
- possibly a new focused TUI render/flow test if needed

## Manual checks

Verify in a real terminal:

- simple tool call
- nested tool call
- failed tool call
- long output preview truncation
- compiled binary behavior after `bun run build`

---

## Recommended implementation order

1. add compact tool preview summarization in `src/frontend-events.ts`
2. preserve those previews through `src/procedure-dispatch-progress.ts`
3. refactor TUI state from ephemeral tool lines to persistent tool cards
4. add a local tool-card component and theme tokens
5. move tool rendering into the transcript region
6. add generic fallback rendering
7. polish known built-in tool formatting
8. verify `--no-tool-calls` and wrapper suppression still behave correctly

---

## Risks and caveats

## 1. Payload size regression

If full ACP raw payloads leak into SSE history, memory and replay size will grow quickly.

### Mitigation

Summarize early and cap preview sizes.

## 2. ACP titles are less structured than pi-mono internal tool definitions

Some downstream agents may only provide a title string plus vague `kind`.

### Mitigation

Treat generic fallback rendering as first-class, not as an afterthought.

## 3. Async/default-session bridge currently drops too much

If this is not fixed, nested tool cards will still look incomplete.

### Mitigation

Carry compact preview fields through the bridge before doing any view work.

## 4. Transcript growth

Keeping completed tool cards means more retained UI content per run.

### Mitigation

Keep cards concise and bounded. Only meaningful tool cards should persist.

---

## Success criteria

This work is successful when all of the following are true:

1. nanoboss renders one card per meaningful ACP tool call in the TUI
2. cards update in place through pending -> completed/failed lifecycle
3. completed cards remain in the transcript after the run ends
4. nested/default-session tool cards still have useful result previews
5. `--no-tool-calls` still suppresses tool rendering cleanly
6. wrapper/orchestration noise remains suppressed or collapsed
7. the overall experience clearly resembles pi-mono's tool-call card model

---

## Bottom line

The right way to align with pi-mono is **not** to prettify the existing activity lines.

The right way is to copy pi-mono's structure:

- a persistent per-tool card model
- inline transcript rendering
- a generic tool-card shell
- optional known-tool formatters
- bounded summarized payloads rather than raw ACP blobs

That gives nanoboss the same UX shape while staying native to its current ACP + SSE + pi-tui architecture.
