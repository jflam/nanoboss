# 2026-03-31 Plan: Multi-Turn Session History and Prior Procedure Result Context

## Status

Urgent, not yet implemented.

This is the highest-priority conversational correctness gap in `nanoboss` right now.

---

## Executive summary

There are **two representations of reality** in `nanoboss`, and the design needs to respect both.

### Reality 1: native ACP session continuity

This is the state the downstream agent itself needs in order to resume correctly:

- vendor/native conversation state
- tool-call shape continuity
- model-side caches
- any hidden session state preserved by ACP `session/load`

This is the right mechanism for `/default`, because `/default` is the canonical chat loop.

### Reality 2: semantic session history in `SessionStore`

This is the higher-level application state we persist ourselves:

- prior procedure inputs/outputs
- summaries
- structured results
- refs and values TypeScript procedures can reason over

This is the right mechanism for:

- explicit reasoning over prior results
- programmatic follow-ups
- typed composition
- procedures that want to reuse previous outputs intentionally

### Why the current design is broken

Today `commands/default.ts` behaves like a stateless single-turn passthrough:

```ts
const result = await ctx.callAgent(prompt);
```

That means subsequent prompts do **not** automatically include:

- prior user turns
- prior assistant answers
- prior procedure outputs
- durable machine-readable results from earlier procedure calls
- native ACP session continuity

As a result, the session does not behave like a conversation.

Example of current broken behavior:

1. User: `what is 2+2`
2. Assistant: `4`
3. User: `add 3 to result`
4. Expected: `7`
5. Actual: downstream agent receives only `add 3 to result` with no conversational context

This makes `nanoboss` feel like a sequence of disconnected one-off calls instead of a chat.

### Correct direction

The fix is not just “send more text.”

We need a clear model where:

1. `/default` uses native ACP session continuity first
2. `SessionStore` remains available as the higher-level semantic memory layer
3. transcript injection / history materialization is the fallback or explicit reasoning path, not the only continuation mechanism

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

Do **not** collapse native session continuity and semantic session history into one mechanism.

We need both, but for different purposes.

### Why native resume matters

If `/default` resumes only by reconstructing prompt text, we lose:

- native tool-call continuity
- model-side caches
- vendor session behavior
- the most efficient path for follow-up turns

This is specifically what agentboss avoids by preferring ACP `session/load` when available.

### Why semantic history still matters

Even with native resume, we still need our own higher-level memory for:

- prior procedure results
- typed outputs
- refs
- programmatic reasoning by TypeScript procedures
- fallback transcript reconstruction when native resume is unavailable

### Correct approach

For `/default`:

1. prefer **native ACP session continuity**
2. fall back to **transcript/history reconstruction** only when native resume is unavailable

For procedures and explicit reasoning:

1. use **`SessionStore`-derived semantic history**
2. include transcript and structured summaries only when the caller opts in

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

## 1. Implement native ACP session continuity for `/default`

`/default` should stop behaving like a fresh one-shot `callAgent()` invocation on every turn.

Instead, each `nanoboss` session should have a corresponding native ACP session identity for the canonical chat loop.

Simplest intended behavior:

- first `/default` turn for a session:
  - create a native ACP session
  - persist its ACP session id alongside the `nanoboss` session
- later `/default` turns in the same live process:
  - reuse the same native ACP client/session if still resident
- if the live ACP client is gone but an ACP session id exists:
  - create a new ACP client
  - attempt native `session/load`
  - resume that session
- only if native resume is unavailable or fails:
  - fall back to transcript reconstruction from `SessionStore`

### Why this should follow agentboss

This is the same basic shape agentboss already uses.

Relevant reference implementation:

- `~/agentboss/workspaces/agentboss/crates/agentboss-executor/src/runtime/orchestration.rs`
  - `resume_executor_session(...)`
- `~/agentboss/workspaces/agentboss/crates/agentboss-acp/src/session.rs`
  - `load_session(...)`
- `~/agentboss/workspaces/agentboss/crates/agentboss-acp/src/client.rs`
  - resume/load helpers

Agentboss flow, simplified:

1. persist ACP session id
2. on follow-up, attempt native `session/load`
3. if native load succeeds, continue with the same native conversation
4. if native load fails, fall back to transcript injection
5. persist ACP session id again for future resume

`nanoboss` should follow the same order of precedence.

## 2. Make semantic session history explicitly keyed by `sessionId`

The history helper should accept a `sessionId`.

That is the simplest correct boundary because:

- session state is already persisted per session
- multi-turn continuity is a property of a session, not of `callAgent()` in general
- most `callAgent()` uses are still one-shot and should remain simple
- some procedures may intentionally want to issue follow-up calls against the same session later

So the central helper should look conceptually like:

```ts
materializeSessionHistory(sessionId: string, options?: ...)
```

This helper should build context from the durable session store for that session.

### Why this is simpler than implicit history

`callAgent()` is a general-purpose primitive. If it implicitly assumes conversational continuity, it becomes harder to reason about and harder to reuse.

By contrast, a `sessionId`-keyed history helper keeps the model simple:

- no semantic history unless the caller explicitly asks for it
- `/default` gets native continuity by design, not by overloading `callAgent()`
- other procedures can remain one-shot by default
- future programmatic follow-ups can opt into the same session history intentionally

Conceptually, when history is enabled, downstream prompts become:

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

## 3. Special-case `/default` to use native continuity first and semantic history second

`commands/default.ts` should no longer be treated as a plain one-shot `ctx.callAgent(prompt)` wrapper.

Instead, `/default` should use a dedicated continuation path for the current session.

Conceptually:

```ts
continueDefaultSession({
  sessionId: ctx.sessionId,
  prompt,
})
```

That continuation path should:

1. use the existing live ACP session for the current `sessionId` if available
2. otherwise attempt ACP `session/load` using the persisted ACP session id
3. otherwise fall back to transcript reconstruction using `SessionStore`

The important point is:

- `/default` must know which session it is continuing
- it should not depend only on synthetic prompt rebuilding when native resume is possible

### Why start with `/default`

- it is the primary conversational surface
- users expect chat continuity there first
- it is where native ACP continuity matters the most
- it avoids overcomplicating generic `callAgent()`

---

## 4. Preserve explicit composition for procedures

Not every procedure should automatically inherit the whole conversation.

Examples:

- deterministic/typed procedures may want a clean prompt
- utility procedures may want only explicit refs
- some procedures may want transcript context but not recent structured summaries
- some procedures may want to issue a follow-up against the same session later and should be able to do so explicitly

So the API should support opt-in levels, not one global behavior.

### Recommended option shape

Evolve `CommandCallAgentOptions` with explicit history controls keyed by `sessionId`.

Example direction:

```ts
interface CommandCallAgentOptions {
  agent?: DownstreamAgentSelection;
  stream?: boolean;
  refs?: Record<string, CellRef | ValueRef>;
  history?: {
    sessionId: string;
    transcript?: boolean;       // include recent conversational turns
    sessionSummaries?: boolean; // include recent cell summaries + refs
    limit?: number;             // number of recent cells to include
  };
}
```

### Recommended defaults

- `/default`
  - do not go through generic one-shot history-only path
  - use dedicated native continuation path for current session
- most existing procedures
  - no history block at all
  - keep current one-shot behavior unless explicitly updated
- procedures that want semantic follow-up behavior
  - opt in explicitly with `history.sessionId`

This avoids silently changing semantics for every procedure.

---

## 5. Expose current `sessionId` on `CommandContext`

For `/default` to pass the current session identity cleanly, `CommandContext` should expose it directly.

Recommended simplest addition:

```ts
interface CommandContext {
  readonly sessionId: string;
  ...
}
```

This is better than trying to infer session identity indirectly from cells or refs.

It also supports future cases where a procedure intentionally issues programmatic follow-ups against the same session.

## 6. Build history from `SessionStore`, not ad hoc terminal text

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

## Phase 0: copy the agentboss resume model deliberately

Before implementing, use the agentboss flow as the reference shape.

Concrete files to study and mirror:

- `~/agentboss/workspaces/agentboss/crates/agentboss-executor/src/runtime/orchestration.rs`
  - `resume_executor_session(...)`
- `~/agentboss/workspaces/agentboss/crates/agentboss-acp/src/session.rs`
  - `load_session(...)`
- `~/agentboss/workspaces/agentboss/crates/agentboss-acp/src/client.rs`
  - session resume/load helpers

The implementation in `nanoboss` does not need all the daemon/executor complexity, but it should preserve the same core order:

1. reuse live native session when possible
2. otherwise try native `session/load`
3. otherwise use transcript fallback

## Phase 1: persist ACP session identity for each `nanoboss` session

Extend `nanoboss` session state so the canonical `/default` loop can remember:

- current ACP session id
- optionally the live ACP client/connection if it is still resident
- enough metadata to decide whether native resume is possible

This should be simple and explicit. Avoid mixing this state into `SessionStore` cell records.

It belongs to session runtime state, not semantic result history.

## Phase 2: implement `/default` native continuation path

Add a dedicated helper for `/default`, conceptually something like:

```ts
continueDefaultSession(sessionId: string, prompt: string)
```

Responsibilities:

- look up live native ACP state for `sessionId`
- if present, continue with that native session
- else, create ACP client and attempt `session/load` using persisted ACP session id
- if load succeeds, continue natively
- if load fails or no ACP session id exists, fall back to transcript/history reconstruction
- after successful new session creation or resume, persist ACP session id again

This is the most important phase for preserving native caches and tool-call continuity.

## Phase 3: define a `sessionId`-keyed history materializer

Add a helper that turns recent session state for a specific session into prompt-ready context.

Possible file:

- `src/history-context.ts`

Proposed responsibilities:

- accept `sessionId`
- load the corresponding `SessionStore` / session data
- fetch recent cells from that session
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

## Phase 4: extend `CommandCallAgentOptions`

Update `src/types.ts` and callers.

Add explicit history settings keyed by `sessionId`.

Keep the API conservative:

- no global implicit history for every call
- only opt in where desired
- make the session identity explicit at the call site

---

## Phase 5: pass session history from `CommandContextImpl.callAgent(...)`

Today `CommandContextImpl.callAgent(...)` resolves only explicit named refs.

We need to extend it so that when history options are enabled, it also passes materialized session history for the specified `sessionId` into `invokeAgent(...)`.

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

## Phase 6: update `buildPrompt(...)`

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

## Phase 7: make `/default` conversational via native resume

Update `commands/default.ts` so it stops being a plain one-shot `ctx.callAgent(prompt)` wrapper.

This is the key user-facing behavior change.

Likely target behavior:

- pass `ctx.sessionId`
- use dedicated native continuation path first
- only use transcript/session-summary materialization as fallback
- still return the final downstream display as today

---

## Phase 8: define transcript rendering rules

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

## Phase 9: define structured summary rendering rules

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

## Phase 10: add tests

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

- `/default` persists ACP session id after first turn
- `/default` reuses or resumes native session on second turn
- `/default` second turn can use the first turn result
- transcript fallback activates when native resume is unavailable
- prior procedure summaries are included in later `/default` calls when semantic history is requested

### Deterministic e2e tests

Using the existing mock-agent infrastructure, add cases like:

#### Case 0: native session continuity path

- prompt 1 creates a native ACP session and persists its session id
- prompt 2 reuses that session or resumes via native `session/load`
- assert the mock agent can observe that the same native session was continued
- assert no transcript fallback path was used in the happy path


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
- other procedures opt in intentionally by supplying a `sessionId`

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

1. copy the agentboss native resume shape deliberately
2. persist ACP session identity per `nanoboss` session
3. expose `sessionId` on `CommandContext`
4. implement dedicated `/default` native continuation path
5. add `sessionId`-keyed history materializer module
6. extend `CallAgentOptions` / `CommandCallAgentOptions` with history controls carrying `sessionId`
7. update `buildPrompt(...)` to render transcript + summaries separately
8. make `/default` use semantic history only as fallback
9. add deterministic native-resume e2e test
10. add arithmetic follow-up deterministic e2e test
11. add mixed-procedure-history deterministic e2e test
12. only after that, consider whether additional procedures should opt in

---

## Concrete starting tasks for a sub-agent

If dispatching an agent, give it this sequence:

### Task 1
Study and mirror the agentboss native resume flow from:

- `crates/agentboss-executor/src/runtime/orchestration.rs`
- `crates/agentboss-acp/src/session.rs`
- `crates/agentboss-acp/src/client.rs`

### Task 2
Persist ACP session identity per `nanoboss` session and expose current session identity on `CommandContext`.

### Task 3
Implement a dedicated `/default` continuation path that:

- reuses a live native ACP session when possible
- otherwise attempts ACP `session/load`
- otherwise falls back to transcript reconstruction

### Task 4
Implement a first-class `sessionId`-keyed semantic history materializer from `SessionStore`.

### Task 5
Extend `callAgent(...)` prompt construction to accept and render semantic session history context for an explicit `sessionId`.

### Task 6
Update `/default` so semantic history is used only as fallback / supplementary context, not as the primary continuation mechanism.

### Task 7
Add deterministic mock-agent-backed e2e coverage for:

- `what is 2+2` -> `4`
- `add 3 to result` -> `7`

### Task 8
Add a mixed-history case where a prior procedure result is referenced by a later default turn.

---

## Recommendation

Proceed immediately.

This is more important than secondary observability work because it blocks the most basic user expectation: that a session is actually a conversation.
