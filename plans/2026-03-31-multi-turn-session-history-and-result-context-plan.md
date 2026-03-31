# 2026-03-31 Plan: Multi-Turn Session History and Prior Procedure Result Context

## Status

Urgent, not yet implemented.

This is the highest-priority conversational correctness gap in `nanoboss` right now.

---

## Executive summary

Today `commands/default.ts` behaves like a stateless single-turn passthrough:

```ts
const result = await ctx.callAgent(prompt);
```

That means subsequent prompts do **not** automatically include:

- prior user turns
- prior assistant answers
- prior procedure outputs
- durable machine-readable results from earlier procedure calls

As a result, the session does not behave like a conversation.

Example of current broken behavior:

1. User: `what is 2+2`
2. Assistant: `4`
3. User: `add 3 to result`
4. Expected: `7`
5. Actual: downstream agent receives only `add 3 to result` with no conversational context

This makes `nanoboss` feel like a sequence of disconnected one-off calls instead of a chat.

The fix is not just “send more text.”

We need a clear session-history model that includes **both**:

1. conversational transcript context for natural-language continuity
2. structured references to prior procedure results for durable machine-readable reuse

---

## Problem statement

### Current behavior

Relevant current implementation pieces:

- `commands/default.ts`
  - forwards only the current prompt via `ctx.callAgent(prompt)`
- `src/call-agent.ts`
  - `buildPrompt(...)` supports only:
    - current prompt
    - optional typed schema instructions
    - optional named refs passed explicitly by the caller
- `src/context.ts`
  - exposes `ctx.session.last()` / `ctx.session.recent(...)`
  - but does **not** automatically use session history for `/default`
- `src/session-store.ts`
  - persists prior cells/results durably
  - but these are not automatically materialized into downstream prompts

### Why this is a product bug

For a chat-oriented interface, users expect:

- follow-up turns to build on prior turns
- references like “that”, “the result”, “the previous answer”, “the file you wrote”, etc. to work naturally
- prior structured outputs to be reusable even when the prior turn was a procedure, not plain assistant text

Without this, the CLI and future web frontend fail the basic conversational expectation.

---

## Design goal

Make a session behave like a coherent multi-turn conversation while preserving the useful structured execution model already present in `nanoboss`.

The desired end state is:

- `/default` acts like a real chat continuation
- other procedures can also opt into prior context consistently
- previous procedure outputs are available in both:
  - human-readable summary form
  - machine-readable ref form
- context stays bounded and understandable
- typed / deterministic procedure composition still works

---

## Key design principle

Do **not** choose between transcript context and structured result context.
We need both.

### Why transcript-only is insufficient

If we only append prior plain text transcript, we lose:

- durable handles to structured results
- precise reuse of prior data
- ref-based composition guarantees
- a good way to reference non-display outputs

### Why refs-only is insufficient

If we only pass structured refs, we lose:

- natural language continuity
- conversational grounding
- pronoun/reference resolution for ordinary follow-up chat
- compatibility with normal model behavior that expects recent transcript

### Correct approach

For subsequent turns, include:

1. **recent conversational history** in a prompt-friendly transcript form
2. **structured session context** derived from prior cell summaries and refs

---

## User-visible behaviors we want

### Example 1: conversational follow-up

User:

```text
what is 2+2
```

Assistant:

```text
4
```

User:

```text
add 3 to result
```

Desired downstream understanding:

- prior assistant answer was `4`
- “result” refers to that answer
- output should be `7`

### Example 2: follow-up after a procedure

User:

```text
/linter fix this repo
```

Procedure result includes:

- display summary for the user
- structured refs containing linter results, files, recommendations, etc.

User:

```text
explain the most important error you fixed
```

Desired downstream understanding:

- recent transcript contains a readable summary of what happened
- structured context includes refs to the linter run result
- model can answer coherently

### Example 3: follow-up after a generated artifact/result

User:

```text
/create a procedure that summarizes package.json
```

Later user:

```text
run it on this repo and then refine it to also include scripts
```

Desired downstream understanding:

- prior turn created a procedure
- session retains enough context to know what “it” refers to
- structured cell history can point at the generated procedure result

---

## Recommended architecture

## 1. Introduce explicit session-history materialization for downstream prompts

Add a new context-building step before downstream agent invocation.

Conceptually:

- current user prompt
- plus recent session transcript
- plus recent procedure/cell summaries with refs
- plus any explicit named refs passed by the current caller

### Proposed layering

#### Layer A: transcript context

A compact recent-turn transcript such as:

```text
Recent session transcript:
User: what is 2+2
Assistant: 4
User: add 3 to result
```

This is optimized for conversational continuity.

#### Layer B: structured session summaries

A compact machine-oriented block derived from recent cells:

```text
Recent session results:
- procedure=default summary="4" cell=session/.../cell...
- procedure=linter summary="configured lint run with 3 errors" dataRef=...
- procedure=second-opinion summary="second-opinion: ... (mixed)" dataRef=...
```

This is optimized for discoverability and structured reuse.

#### Layer C: explicit named refs

Keep the existing `<ref name="...">...</ref>` mechanism for exact caller-specified refs.

This remains the highest-precision mechanism.

---

## 2. Special-case `/default` to opt into automatic history

`commands/default.ts` should no longer call plain:

```ts
ctx.callAgent(prompt)
```

Instead it should call something equivalent to:

```ts
ctx.callAgent(prompt, {
  includeSessionHistory: true,
})
```

Whether the option is implicit inside `/default` or generalized in the API is an implementation detail, but `/default` must stop being stateless.

### Why start with `/default`

- it is the primary conversational surface
- users expect chat continuity there first
- it isolates the most urgent bug without forcing every procedure to adopt history automatically

---

## 3. Preserve explicit composition for procedures

Not every procedure should automatically inherit the whole conversation.

Examples:

- deterministic/typed procedures may want a clean prompt
- utility procedures may want only explicit refs
- some procedures may want transcript context but not recent structured summaries

So the API should support opt-in levels, not one global behavior.

### Recommended option shape

Evolve `CommandCallAgentOptions` with explicit history controls.

Example direction:

```ts
interface CommandCallAgentOptions {
  agent?: DownstreamAgentSelection;
  stream?: boolean;
  refs?: Record<string, CellRef | ValueRef>;
  history?: {
    transcript?: boolean;      // include recent conversational turns
    sessionSummaries?: boolean; // include recent cell summaries + refs
    limit?: number;            // number of recent turns/cells to include
  };
}
```

### Recommended defaults

- `/default`
  - transcript: true
  - sessionSummaries: true
- most existing procedures
  - transcript: false
  - sessionSummaries: false
  - keep current behavior unless explicitly updated

This avoids silently changing semantics for every procedure.

---

## 4. Build history from `SessionStore`, not ad hoc terminal text

The durable source of truth should be the existing session store and cell model.

That lets us derive history from:

- `CellRecord.input`
- `CellRecord.output.display`
- `CellRecord.output.summary`
- refs to `output.data`, `output.display`, `output.stream`
- procedure names and timestamps

This is better than scraping terminal output because:

- it is deterministic
- it survives frontend differences
- it already represents the execution graph we care about

---

## Detailed implementation plan

## Phase 1: define a history materializer

Add a helper that turns recent session state into prompt-ready context.

Possible file:

- `src/history-context.ts`

Proposed responsibilities:

- fetch recent cells from `SessionStore`
- derive a compact transcript view
- derive a compact summary/ref view
- return structured material that `buildPrompt(...)` can render

### Proposed data shape

Example:

```ts
interface MaterializedSessionHistory {
  transcriptLines: string[];
  resultSummaries: Array<{
    procedure: string;
    summary?: string;
    dataRef?: ValueRef;
    displayRef?: ValueRef;
    streamRef?: ValueRef;
    createdAt: string;
  }>;
}
```

This can then be rendered into prompt text in one place.

---

## Phase 2: extend `CommandCallAgentOptions`

Update `src/types.ts` and callers.

Add explicit history settings.

Keep the API conservative:

- no global implicit history for every call
- only opt in where desired

---

## Phase 3: pass session history from `CommandContextImpl.callAgent(...)`

Today `CommandContextImpl.callAgent(...)` resolves only explicit named refs.

We need to extend it so that when history options are enabled, it also passes materialized session history into `invokeAgent(...)`.

There are two clean designs.

### Option A: expand `CallAgentOptions.namedRefs`

Encode transcript/history as synthetic refs.

Example:

- `session_transcript`
- `recent_results`

Pros:

- reuses existing prompt construction path

Cons:

- mixes conversational history with caller-specified refs awkwardly

### Option B: add a first-class history field to `CallAgentOptions`

Example:

```ts
interface CallAgentOptions {
  config?: DownstreamAgentConfig;
  namedRefs?: Record<string, unknown>;
  historyContext?: MaterializedSessionHistory;
  ...
}
```

Then `buildPrompt(...)` renders history separately from named refs.

**Recommendation: prefer Option B.**

It keeps transcript/history semantically distinct from explicit refs.

---

## Phase 4: update `buildPrompt(...)`

Modify `src/call-agent.ts` so prompt construction can render:

1. recent transcript block
2. recent result summary block
3. explicit named refs block
4. current prompt
5. typed schema instructions, if applicable

### Important ordering recommendation

Suggested order:

1. system-like guidance for how to use history
2. recent transcript
3. recent structured summaries
4. explicit named refs
5. current user request
6. schema/JSON instructions if typed

Reasoning:

- the current request should remain the focal point
- but the model needs context before it answers
- typed instructions should remain near the end so they strongly constrain output format

---

## Phase 5: make `/default` conversational

Update `commands/default.ts` so it opts into automatic history.

This is the key user-facing behavior change.

Likely target behavior:

- include recent transcript
- include recent session summaries
- still return the final downstream display as today

---

## Phase 6: define transcript rendering rules

We should not dump raw unbounded history.

Need a bounded, readable rendering policy.

### Recommended initial heuristic

Use recent cells only, e.g. last 6–10 relevant cells, excluding the currently running cell.

For each cell:

- if procedure is `default`
  - render as a normal chat exchange:
    - user input from `CellRecord.input`
    - assistant text from `output.display` or `output.stream`
- if procedure is not `default`
  - render a concise system-style entry:
    - procedure name
    - input summary
    - output summary

Example:

```text
Recent transcript:
User: what is 2+2
Assistant: 4
System: /linter ran on the repo and fixed several lint issues. Summary: configured lint run with 3 errors.
User: add 3 to result
```

This preserves the chat feel while acknowledging procedure turns.

---

## Phase 7: define structured summary rendering rules

We should also include a compact block of recent procedure outputs with refs.

Example:

```text
Recent session results:
- procedure=default summary="4"
- procedure=linter summary="configured lint run with 3 errors" dataRef=session/.../output.data
- procedure=second-opinion summary="second-opinion: ... (mixed)" dataRef=session/.../output.data
```

This gives the model durable anchors beyond plain transcript.

Important: do **not** inline huge `output.data` blobs by default.
Only include summary + ref identity in the history block.
If a specific procedure wants exact values, it should still pass explicit refs.

---

## Phase 8: add tests

This work needs substantial coverage.

### Unit tests

#### `buildPrompt(...)`

Add tests that assert prompt construction includes:

- recent transcript when enabled
- recent summaries when enabled
- explicit named refs separately
- schema block still present for typed calls

#### history materializer

Add tests for:

- default-only conversations
- mixed default/procedure history
- bounded limits
- excluding current cell
- preferring display/stream/summary in the right order

### Integration / service tests

Add tests ensuring:

- `/default` second turn can use the first turn result
- prior procedure summaries are included in later `/default` calls

### Deterministic e2e tests

Using the existing mock-agent infrastructure, add cases like:

#### Case 1: arithmetic follow-up

- prompt 1: `what is 2+2`
- mock agent returns `4`
- prompt 2: `add 3 to result`
- assert downstream prompt seen by mock agent includes enough history to answer `7`
- mock agent returns `7`

#### Case 2: mixed procedure history

- run a procedure that returns structured result + display
- then ask `/default` a follow-up referring to it
- assert the built prompt contains transcript + summary context

---

## Open design questions

## 1. How much history should we include by default?

Recommendation:

- start with a small bounded window (e.g. 6 recent cells)
- prefer recency over deep transcript replay

We can add smarter summarization later if needed.

## 2. Should procedure results be rendered as transcript, summaries, or both?

Recommendation:

- both
- transcript for conversational continuity
- summaries/refs for structured grounding

## 3. Should all procedures opt into history automatically?

Recommendation:

- no
- only `/default` initially
- other procedures opt in intentionally

## 4. Should prior `output.data` be auto-inlined?

Recommendation:

- no
- only auto-include concise summary + ref identity
- use explicit refs for exact prior values

This avoids prompt bloat and accidental leakage of large structured data.

---

## Risks

### 1. Prompt bloat

If we dump too much transcript and too many summaries, prompts will grow quickly.

Mitigation:

- bounded recent window
- summaries instead of full payloads
- explicit refs for large/exact data

### 2. Confusing role semantics

If procedure outputs are injected naively, the model may misinterpret them as user text.

Mitigation:

- render procedure turns clearly as system/procedure entries, not fake user lines

### 3. Hidden behavioral change for procedures

If we auto-enable history everywhere, existing procedure behavior may shift unexpectedly.

Mitigation:

- opt in only for `/default` first

### 4. Overlapping transcript + summaries causing duplication

Some redundancy is okay, but too much will confuse the model.

Mitigation:

- transcript remains concise
- summaries stay compact and structured
- avoid repeating huge assistant text in both places

---

## Success criteria

This work is successful if:

1. `/default` behaves like a real multi-turn conversation
2. “add 3 to result” after “what is 2+2” yields `7`
3. follow-ups after non-default procedures can refer to prior results coherently
4. prompt construction remains bounded and understandable
5. existing deterministic / typed procedure composition still works
6. deterministic tests cover the behavior

---

## Recommended implementation sequence

1. add history materializer module
2. extend `CallAgentOptions` / `CommandCallAgentOptions` with history controls
3. update `buildPrompt(...)` to render transcript + summaries separately
4. make `/default` opt into history
5. add arithmetic follow-up deterministic e2e test
6. add mixed-procedure-history deterministic e2e test
7. only after that, consider whether additional procedures should opt in

---

## Concrete starting tasks for a sub-agent

If dispatching an agent, give it this sequence:

### Task 1
Implement a first-class session-history materializer from `SessionStore`.

### Task 2
Extend `callAgent(...)` prompt construction to accept and render session history context.

### Task 3
Update `commands/default.ts` to include recent transcript + session summaries automatically.

### Task 4
Add deterministic mock-agent-backed e2e coverage for:

- `what is 2+2` -> `4`
- `add 3 to result` -> `7`

### Task 5
Add a mixed-history case where a prior procedure result is referenced by a later default turn.

---

## Recommendation

Proceed immediately.

This is more important than secondary observability work because it blocks the most basic user expectation: that a session is actually a conversation.
