# Design doc: Async procedure dispatch with context capture and ACP session isolation

## Problem

Slash commands such as `/autoresearch` are dispatched by sending an internal control prompt through the session's default ACP conversation. That preserves access to the parent conversation context, but today it also allows the async dispatch path to reuse the same persisted ACP session identity as the foreground conversation.

That coupling is safe for inline, synchronous procedure execution, but it breaks down once a procedure becomes async, resumable, or backgrounded. In that mode the procedure is no longer a normal lexical closure over the current turn; it becomes an independent execution that can outlive the parent turn, emit its own tool traffic, and recover results later. Reusing the same live ACP session for both orchestration and async execution can contaminate stored results and blur provenance.

The observed failure mode is an impossible top-level result: procedure `autoresearch` paired with summary `autoresearch-finalize: missing state`, with replay events showing outer MCP dispatch tools instead of a real worker-owned `/autoresearch` execution.

## Design goal

Preserve the useful mental model that a slash procedure inherits the enclosing conversation's context, while preventing async procedure dispatch from sharing the same live ACP execution stream as the foreground conversation.

## Goals

1. Preserve closure-like context inheritance for procedures.
2. Keep synchronous slash-command behavior unchanged.
3. Isolate async/resumable procedure dispatch from the caller's live ACP session.
4. Make dispatch provenance explicit and verifiable end-to-end.
5. Keep recovery and memory synchronization safe when structured dispatch payloads are missing.

## Non-goals

1. Remove context inheritance from procedures.
2. Rewrite the autoresearch procedure itself.
3. Replace the existing MCP dispatch protocol.
4. Solve every future multi-agent orchestration problem in this change.

## First-principles model

### 1. Foreground synchronous procedure

This is the true "closure over the enclosing lexical scope" case.

- It runs inside the current turn.
- It may rely on the same current conversational context as `/default`.
- Sharing the parent conversation is acceptable because there is only one active execution stream.

### 2. Async or resumable procedure

This is a **forked closure**, not a normal closure.

- It inherits context from the parent.
- It must not share the same live ACP session object as the parent.
- Its input context should be captured as a snapshot at dispatch time.

The key rule is: **inherit context, do not alias the live session.**

## Current architecture summary

### Dispatch path

- `NanobossService.dispatchProcedureIntoDefaultConversation()` sends an internal control prompt through `session.defaultConversation.prompt(...)`.
- `buildProcedureDispatchPrompt(...)` instructs the agent to call `procedure_dispatch_start` and poll `procedure_dispatch_wait`.
- `extractProcedureDispatchResult(...)` attempts to parse the terminal dispatch payload from tool updates.
- `waitForRecoveredProcedureDispatchCell(...)` falls back to top-level cell recovery keyed by procedure name and dispatch correlation id.

### Session reuse behavior

- `DefaultConversationSession.prompt()` reuses `persistedSessionId` when available.
- `SessionMetadata` persists that ACP identity as `defaultAcpSessionId`.
- Resumed NanoBoss sessions restore `defaultAcpSessionId` and reload the same ACP conversation.

### Why this is unsafe for async dispatch

The dispatch control prompt, the foreground conversation, and any later recovery or memory sync can all end up addressing the same ACP session. That means the async procedure orchestration channel and the user-facing reasoning channel are not actually distinct. Once that happens, tool traces and final results can be attributed to the wrong logical execution.

## Proposed feature

### Feature name

**Context-captured async procedure dispatch**

### Core idea

Keep one ACP lane for the foreground/default conversation and a separate ACP lane for async slash-command dispatch, while explicitly snapshotting the parent context that the async lane should inherit.

## Proposed architecture

### 1. Split conversation roles

Introduce two distinct roles:

1. **Foreground conversation**
   - current `/default` conversational lane
   - persists as `defaultAcpSessionId`
   - continues to represent the user's main thread

2. **Dispatch conversation**
   - fresh ACP session used only for one async slash-command dispatch flow
   - never reuses the foreground conversation's live ACP session id
   - may be ephemeral, or later become a separately owned dispatch lane

The initial implementation should prefer the simpler rule: **create a fresh ACP session per async dispatch**.

### 2. Capture parent context explicitly

At dispatch time, build a `ProcedureDispatchContextSnapshot` that captures the context the async procedure needs without requiring the parent's live ACP session.

Recommended contents:

- procedure name and prompt
- current user prompt or parent command text
- selected memory cards or summaries relevant to the procedure
- recent turn summary rather than raw full transcript
- current agent selection
- durable refs or cell refs when exact prior outputs matter

This snapshot should be compact, explicit, and intentionally scoped.

### 3. Use the snapshot to seed dispatch reasoning

The dispatch ACP session should receive:

- the existing dispatch control prompt
- the context snapshot
- explicit instructions that the dispatch is derived from the parent conversation

This preserves the "closure" intuition while keeping execution isolated.

### 4. Harden provenance

Dispatch results and recovery should carry enough identity to prove they belong to the current dispatch.

Add or validate the following across the pipeline:

- `dispatchId`
- `dispatchCorrelationId`
- procedure name
- target NanoBoss session id
- cell ownership or source markers where useful

`extractProcedureDispatchResult(...)` should reject terminal payloads that do not match the dispatch started in the current flow.

### 5. Tighten recovery rules

Recovery should only accept cells that are clearly owned by the dispatch worker for the current correlation id.

That likely means:

- exact `dispatchCorrelationId` match
- expected procedure name
- top-level worker-produced cell, not a replay-patched outer control cell
- optional stronger ownership metadata if needed

### 6. Keep sync semantics unchanged

Do **not** change the behavior of inline child procedure execution that happens inside a single top-level run. The new isolation rule applies specifically to the async slash-command dispatch path.

## Data model changes

### Session metadata

Retain:

- `defaultAcpSessionId` for the foreground conversation

Do not reuse it for:

- async dispatch control prompts
- recovered procedure sync prompts

Optional follow-up if needed:

- add a dedicated `dispatchAcpSessionId`
- or keep dispatch ACP sessions entirely ephemeral and unpersisted

## Execution flow after the change

### User flow

1. User starts a NanoBoss session.
2. User runs `/autoresearch <task>`.
3. NanoBoss captures the parent-context snapshot.
4. NanoBoss creates a fresh dispatch ACP session.
5. That dispatch ACP session performs the MCP start/wait loop.
6. The worker stores the durable `/autoresearch` result in the target NanoBoss session.
7. Foreground NanoBoss extracts or recovers that exact result and reports it.

### Expected property

The foreground conversation can explain and remember the async procedure, but it cannot be mistaken for the async worker that actually executed it.

## Alternatives considered

### Reuse the same ACP session everywhere

Pros:

- strongest raw context continuity

Cons:

- unsafe once dispatch is async or resumable
- result provenance becomes ambiguous
- concurrent orchestration and reasoning traffic can interleave

Rejected for async dispatch.

### Use a fresh ACP session with no inherited context

Pros:

- clean isolation

Cons:

- loses the closure-like semantics we want
- reduces usefulness for context-dependent procedures

Rejected as too blunt.

## Risks and considerations

1. **Snapshot fidelity**
   - too small: async procedure loses useful context
   - too large: dispatch becomes expensive and noisy

2. **Provider differences**
   - some ACP providers may support session loading differently
   - the design should not depend on load-session support for the dispatch lane

3. **Recovery semantics**
   - recovery must not accidentally "recover" the outer orchestration cell again

4. **Memory synchronization**
   - post-dispatch memory sync should remain one-way and never masquerade as the worker's own result

## Testing strategy

### Unit tests

1. Async slash-command dispatch does not reuse `defaultAcpSessionId` for its ACP lane.
2. Dispatch result extraction rejects payloads that do not match the active dispatch correlation id.
3. Recovery ignores replay-patched outer cells and prefers worker-owned cells.

### Integration tests

1. Start a new session and run `/autoresearch <goal>` from a resumed foreground conversation.
2. Verify baseline state files are created and the returned result is a true `/autoresearch` initialization result.
3. Verify a provider response that strips terminal structured payloads still recovers the correct worker result.
4. Verify cancellation only cancels the async dispatch and does not corrupt foreground conversation state.

## Acceptance criteria

1. The original `/autoresearch <task>` flow succeeds from both fresh and resumed NanoBoss sessions.
2. Stored top-level `/autoresearch` cells contain worker-owned results, not outer MCP replay events.
3. Dispatch result extraction and recovery cannot produce impossible procedure/summary combinations.
4. Synchronous slash-command behavior remains unchanged.
5. Context-dependent procedures still behave as if they inherited the parent conversation, via explicit snapshotting rather than live session aliasing.

## Execution todos

1. `design-dispatch-snapshot`
   - define the context snapshot shape and where it is assembled
2. `isolate-dispatch-acp-lane`
   - route async dispatch prompts through a fresh ACP session instead of `defaultAcpSessionId`
3. `harden-dispatch-provenance`
   - make extraction and recovery verify dispatch identity and ownership
4. `separate-foreground-metadata`
   - ensure `defaultAcpSessionId` remains foreground-only metadata
5. `add-regression-tests`
   - cover resumed-session `/autoresearch`, payload stripping, recovery, and cancellation

## Notes

This is an emergent feature, not just a bug fix. The product behavior being designed is: **async procedures inherit parent context semantically, but execute in an isolated ACP lane with explicit context capture and explicit provenance.**
