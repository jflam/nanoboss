# 2026-04-08 nanoboss scroll-jump and long-chat performance plan

## Status

Completed on 2026-04-08.

The persistent transcript refactor and `pi-tui` upgrade were sufficient to eliminate the observed scroll-jump behavior in manual verification. Additional footer pinning, heartbeat/status isolation, and transcript-owned viewport controls are intentionally deferred because the user-confirmed target behavior is now satisfactory.

## Goal

Fix the current nanoboss TUI behavior where streaming updates can yank the viewport back to the bottom while the user is reading earlier chat history or tool cards, and address the long-chat performance problems that likely share the same root cause.

The target outcome is:

- no distracting jump-to-bottom behavior while the agent is working
- materially better performance on long transcripts
- behavior aligned with `~/src/pi-mono`'s interactive coding-agent where practical

---

## Problem statement

Today nanoboss renders its entire TUI transcript as one rebuilt container tree.

Relevant current behavior:

- `src/tui/app.ts`
  - `syncState()` calls `view.setState(...)` and then `tui.requestRender()`
- `src/tui/views.ts`
  - `NanobossAppView.setState()` clears and rebuilds the entire view tree
  - `appendTranscript()` re-walks every transcript item on each rebuild
- `src/tui/app.ts`
  - `startLiveRefresh()` triggers an additional render every second during active runs so the elapsed timer updates

This differs sharply from `pi-agent` in `~/src/pi-mono`, which keeps persistent chat/tool components and mutates them in place while streaming.

### Symptoms explained by current architecture

1. **Scroll jump / forced return to bottom**
   - `pi-tui` tracks a live viewport and hardware cursor.
   - when nanoboss changes lines above the current viewport, `pi-tui` falls back to a full redraw.
   - nanoboss is unusually likely to do this because it rebuilds the entire view tree and also mutates header/activity/footer lines once per second via the live timer.

2. **Long-chat performance degradation**
   - every state change rebuilds the whole transcript component tree
   - transcript rendering does repeated linear searches through `turns` and `toolCalls`
   - streaming updates therefore scale with transcript size instead of only with the active message/tool component

---

## Comparison with pi-agent

The relevant reference is `~/src/pi-mono/packages/coding-agent/src/modes/interactive/interactive-mode.ts`.

### What pi-agent does differently

- it keeps a persistent `chatContainer`
- on assistant streaming start, it creates one `AssistantMessageComponent`
- on assistant streaming updates, it calls `streamingComponent.updateContent(...)`
- on tool execution start/update/end, it creates a `ToolExecutionComponent` once and then updates that same instance
- it does **not** rebuild the whole transcript container on every event

### Important conclusion

The primary difference is **not** that pi-agent has a special transcript scroll lock feature in `pi-tui`.

The primary difference is that pi-agent:

- mutates long-lived transcript components in place
- avoids whole-transcript rebuild churn
- is on newer `@mariozechner/pi-tui` `0.65.2`, which also coalesces heavy render traffic

This means nanoboss should first be refactored toward pi-agent's component lifecycle before introducing any bespoke scroll feature.

---

## Root-cause hypothesis

The current bug and the current long-chat slowdown are likely the same class of architectural problem.

### Primary causes

1. **Whole-view rebuilds on every state change**
   - `NanobossAppView` is effectively a pure re-rendered transcript instead of a persistent UI tree

2. **Header/footer/activity updates during streaming**
   - the live elapsed timer updates lines near the top/bottom every second
   - that increases the chance that the first changed line is above the visible transcript viewport

3. **Older pi-tui version**
   - nanoboss is pinned to `0.64.0`
   - pi-agent is on `0.65.2`
   - render coalescing improvements likely help under heavy streaming, but they do not by themselves solve the architectural mismatch

### Secondary causes

1. `appendTranscript()` performs repeated `find()` lookups
2. tool cards and turns are recreated instead of updated
3. transcript rendering cost grows with total chat size rather than active delta

---

## Non-goals

- do not attempt a wholesale port of pi-agent interactive mode into nanoboss
- do not try to preserve terminal emulator native scrollback as the primary UX surface
- do not start by forking `pi-tui` unless nanoboss-side architectural fixes prove insufficient

---

## Recommended implementation strategy

Address this in phases, in order of leverage.

## Phase 1: Stop rebuilding the entire transcript

### Goal

Make nanoboss keep persistent transcript components and update them incrementally.

### Approach

Refactor the TUI layer so the transcript area behaves more like pi-agent:

- create a persistent transcript container inside the main app view
- create a persistent component per turn/tool-card when that item first appears
- update existing components in place as content/status changes
- avoid clearing and rebuilding the transcript container on routine streaming updates

### Concrete direction

1. split the current monolithic `NanobossAppView` into:
   - static/persistent header and status components
   - a persistent transcript container
   - persistent editor/footer region

2. maintain transcript item -> component maps
   - turn id -> message component
   - tool call id -> tool card component

3. when reducer state changes:
   - append new transcript components only for newly created items
   - update existing assistant/tool components in place
   - only remove components when a session reset/new session explicitly requires it

### Expected impact

- big reduction in long-chat render cost
- fewer redraw cascades
- closer behavior to pi-agent

---

## Phase 2: Remove streaming-time top-of-screen churn

### Goal

Stop changing non-transcript lines during active runs unless necessary.

### Approach

Review nanoboss's live refresh loop and transient status line updates.

### Specific changes to plan

1. remove or heavily reduce the once-per-second timer-driven full view refresh
2. if elapsed time must remain visible, update it in a way that does not force whole-view rebuilds
3. keep run-state indicators stable during streaming instead of rewriting multiple lines

### Why this matters

Even with persistent transcript components, a timer or status update above the user's viewport can still provoke a redraw pattern that feels like a jump.

---

## Phase 3: Upgrade nanoboss to newer pi-tui

### Goal

Pick up the `0.65.x` renderer improvements already used by pi-agent.

### Approach

Upgrade `@mariozechner/pi-tui` from `0.64.0` to the newer version already in use in `pi-mono`, then adapt nanoboss for any API drift.

### Notes

- this should happen after or alongside the TUI refactor, not as a substitute for it
- the render coalescing change in `0.65.2` should reduce redundant render pressure under streaming load

---

## Phase 4: Verify whether explicit transcript scroll-lock is still needed

### Goal

Determine whether the nanoboss-side architecture fixes are enough to eliminate the observed jump.

### Approach

Reproduce the original scenario after Phases 1-3:

- start a long streaming run with tool cards
- scroll back in history
- observe whether incoming updates still force the viewport back to the bottom

### Decision rule

If the problem is gone or acceptably reduced:

- stop here
- do not add more TUI machinery

If the problem still persists:

- add app-owned transcript viewport state
- only auto-follow when the transcript viewport is already at bottom
- suspend follow when the user pages upward through transcript history

---

## Phase 5: Add explicit transcript viewport control if still required

### Goal

Provide deterministic "do not jump while I am reading history" behavior.

### Approach

Implement an app-owned transcript viewport rather than relying on terminal-native scrollback semantics.

### Planned UX

- `PageUp` / `PageDown` scroll transcript history
- `Home` jumps toward oldest visible transcript
- `End` returns to bottom and reenables follow mode
- while not following, new transcript content accumulates without moving the visible window
- show a small indicator such as "`N` new items below" or "`follow paused`"

### Important constraint

This should be transcript-only viewport state, not a global fork of all `pi-tui` scrolling behavior unless that becomes unavoidable.

---

## Validation plan

## Functional validation

1. Start a streaming assistant response with many tool updates.
2. Scroll back in transcript history while the run continues.
3. Confirm the viewport does not jump to the bottom.
4. Return to bottom and confirm live follow resumes.

## Performance validation

1. Create a transcript with a large number of turns and tool cards.
2. Measure responsiveness during:
   - streaming assistant text
   - tool-card updates
   - queued prompts
   - session resume with retained transcript
3. Compare before/after render smoothness and keystroke latency.

## Regression validation

1. Tool cards still render inline and update correctly.
2. New session/reset still clears transcript correctly.
3. Resume still reconstructs prior transcript correctly.
4. Footer/editor/status behavior remains correct during idle and active runs.

---

## Test plan

Add or update tests in the nanoboss TUI suite to cover:

1. persistent transcript component lifecycle
   - new transcript items append without full view reconstruction semantics

2. streaming updates
   - assistant/tool updates mutate existing components

3. long transcript behavior
   - no quadratic-ish repeated lookup pattern in the view layer

4. transcript follow behavior
   - if explicit viewport state is added, verify:
   - updates do not auto-follow when scrolled away from bottom
   - `End` or equivalent resumes follow mode

5. session reset/resume correctness
   - transcript component maps rebuild only when appropriate

---

## Risks

1. **State/view synchronization complexity**
   - moving from rebuild-everything to persistent components introduces lifecycle bookkeeping

2. **Reducer assumptions leaking into view**
   - the current state shape is optimized for full rebuild, not incremental view updates

3. **pi-tui coupling**
   - if transcript-local scroll control is ultimately needed, some support work may need to happen in the local `pi-tui` seam or via an upgrade

4. **test brittleness**
   - existing tests may assume rebuilt output shape rather than persistent component behavior

---

## Recommended order of execution

1. refactor nanoboss transcript rendering to persistent components
2. remove or isolate timer/status churn during active runs
3. upgrade to newer `pi-tui`
4. reproduce the original bug
5. only if necessary, add explicit transcript viewport/follow-bottom behavior

---

## Success criteria

This work is successful when all of the following are true:

1. While a run is active, the user can inspect earlier chat history or tool cards without the UI snapping back to the bottom.
2. Long transcripts remain responsive during streaming updates.
3. Nanoboss's TUI update pattern is materially closer to pi-agent's persistent-component model.
4. Tool-card streaming, session resume, and normal prompt submission behavior still work correctly.

---

## Outcome

All success criteria were treated as met for this iteration.

1. Manual verification confirmed that the original jump-to-bottom behavior no longer reproduces.
2. The TUI now retains transcript components and updates them incrementally instead of rebuilding the full transcript container on routine streaming changes.
3. Nanoboss is now on `@mariozechner/pi-tui` `0.65.2`.
4. The remaining ideas from Phases 2, 4, and 5 remain valid future options, but they are not required to close this plan.
