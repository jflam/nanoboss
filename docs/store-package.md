# `@nanoboss/store`

`@nanoboss/store` is nanoboss's persistence package. It owns the durable on-disk representation of a session and exposes the read/write APIs that the rest of the system uses to treat that session as a persistent run graph instead of a transient in-memory conversation.

This package is the authority for:

- session-root path resolution under `~/.nanoboss`
- persisted session metadata in `session.json`
- durable run records under `cells/*.json`
- stable refs into stored run output
- traversal over the stored run graph
- prompt-image attachment persistence when images are part of stored run state
- persisted global store-adjacent settings such as the default downstream agent selection
- maintenance helpers for inspecting and pruning stored sessions

This package is not responsible for:

- executing procedures or agents
- live frontend event streams
- transport protocols such as HTTP, SSE, ACP, or MCP
- registry or procedure discovery
- higher-level policy such as which session should be active

## Mental model

There are two persistence layers in this package:

1. `SessionStore`
   Owns one session root and stores individual run records plus ref-addressable values.
2. Session metadata and settings helpers
   Own `session.json`, the workspace-to-current-session cache, and `settings.json`.

If a caller needs to persist or inspect a run, the caller should go through `SessionStore`.

If a caller needs to resume a session, list sessions, or discover the current session for a workspace, the caller should go through the repository helpers in `session-repository.ts`.

## On-disk layout

For a session `session-123`, the package writes under:

```text
~/.nanoboss/
  settings.json
  current-sessions.json
  sessions/
    session-123/
      session.json
      cells/
        1713270000000-<run-id>.json
      attachments/
        <sha256>.<ext>
```

The package treats that layout as the durable source of truth.

- `session.json` is the canonical metadata snapshot for the session.
- `cells/*.json` are the canonical run records.
- `attachments/` holds prompt-image payloads referenced by stored prompt metadata.
- `current-sessions.json` is a workspace-local cache that points to the canonical `session.json`.
- `settings.json` stores global defaults, currently the persisted downstream-agent selection.

## Public surface

The public entrypoint is [packages/store/src/index.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/store/src/index.ts).

The surface breaks down into a few groups.

### 1. Session run storage

`SessionStore` is the core API.

Constructor:

```ts
new SessionStore({
  sessionId: string,
  cwd: string,
  rootDir?: string,
})
```

Responsibilities:

- create and load a session root
- append finalized run records
- expose run summaries and full run records
- resolve refs into stored values
- materialize refs to files
- maintain parent/child indexes for traversal
- persist prompt-image attachments tied to a stored prompt

Primary methods:

- `startRun(...)`
  Creates a draft run with a `RunRef`, creation timestamp, kind, and optional parent linkage.
- `appendStream(draft, text)`
  Buffers stream chunks before finalization.
- `completeRun(draft, result, options?)`
  Writes the finalized cell record and returns refs to stored output fields.
- `patchRun(runRef, patch)`
  Updates an existing stored run record. This is for follow-up durable fields such as replay events, not for replacing the execution model.
- `getRun(runRef)`
  Returns the fully materialized `RunRecord`.
- `listRuns(options?)`
  Returns `RunSummary[]`.
  Default scope is top-level runs.
  `scope: "recent"` returns the most recent matching runs across the session graph.
- `getRunAncestors(runRef, options?)`
  Walks parent links nearest-first.
- `getRunDescendants(runRef, options?)`
  Walks descendants depth-first in stored creation order.
- `readRef(ref)`
  Reads the exact stored value at a ref path.
- `statRef(ref)`
  Returns a lightweight manifest for a ref.
- `writeRefToFile(ref, path, cwd?)`
  Materializes a stored value to disk.
- `persistPromptImages(promptInput)`
  Stages prompt-image attachments and returns `PromptImageSummary[]` that should be passed into `startRun(...)`.
- `discardPendingPromptImages(promptImages)`
  Cleans up staged prompt images when a run fails before persistence.

### 2. Session metadata repository

These helpers define how clients discover stored sessions:

- `writeStoredSessionMetadata(metadata)`
- `readStoredSessionMetadata(sessionId, rootDir?)`
- `listStoredSessions()`
- `readCurrentWorkspaceSessionMetadata(cwd)`

Responsibilities:

- store the canonical session snapshot in `session.json`
- maintain the workspace-keyed `current-sessions.json` cache
- list resumable sessions
- parse persisted continuation metadata

Use these helpers when the client needs to bootstrap into a session before touching any stored runs.

### 3. Settings helpers

- `getNanobossSettingsPath()`
- `readNanobossSettings()`
- `readPersistedDefaultAgentSelection()`
- `writePersistedDefaultAgentSelection(selection)`

These are store-owned because they are durable local persistence, but they are global settings rather than session state.

### 4. Maintenance and presentation helpers

- cleanup helpers:
  `inspectSessionCleanupCandidates`, `selectCleanupCandidates`, `summarizeCleanupCandidates`, `deleteCleanupCandidates`
- formatting helpers:
  `formatSessionLine`, `formatSessionDetailLine`, `formatSessionInitialPrompt`
- value normalization helpers:
  `publicKernelValueFromStored`, `publicContinuationFromStored`
- stored value access helpers:
  internal path lookup, stat preview, and file materialization helpers
- prompt-image attachment helpers:
  internal staging, promotion, rollback, and stale-temp cleanup
- path helpers:
  `getNanobossHome`, `getSessionDir`
- validation helper:
  `parseRequiredDownstreamAgentSelection`

These support store-adjacent workflows, but `SessionStore` plus the metadata helpers are the main contract.

## Interface contract

The package's durable interface is defined in `@nanoboss/contracts`, especially:

- `RunRef`
- `Ref`
- `RunRecord`
- `RunSummary`
- `SessionMetadata`
- `PromptInput`
- `PromptImageSummary`
- `PendingContinuation`

Important rules:

- callers talk about runs through `RunRef`, not filesystem paths
- callers talk about stored values through `Ref`, not by opening cell files directly
- `RunSummary` is the discovery shape
- `RunRecord` is the full stored record
- `SessionMetadata` is the resume/indexing shape

The package intentionally keeps `cell` as an internal storage detail. The public API is run-oriented even though the files are stored as cell records.

## Intended usage

The normal client flow is:

1. Create or load a session root with `SessionStore`.
2. Persist or refresh `session.json` with `writeStoredSessionMetadata(...)`.
3. Start a run with `startRun(...)`.
4. If prompt images exist, call `persistPromptImages(...)` first and pass the returned summaries into `startRun(...)`.
5. Append stream text if needed.
6. Finalize with `completeRun(...)`.
7. Expose stored output to callers using the returned refs, `getRun(...)`, `listRuns(...)`, `getRunAncestors(...)`, and `getRunDescendants(...)`.
8. When a caller needs the concrete payload behind a ref, use `readRef(...)`, `statRef(...)`, or `writeRefToFile(...)`.
9. If a run fails before completion and staged prompt images exist, call `discardPendingPromptImages(...)`.

The executable example for this flow is [packages/store/tests/client-workflow.test.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/store/tests/client-workflow.test.ts).

## Invariants and expectations

Clients should rely on these properties:

- session metadata is separate from run storage
- top-level run listing and recent-run listing are different queries
- parent/child traversal is derived from persisted parent links, not live runtime state
- refs are the stable public addressing mechanism for stored values
- prompt-image files are only promoted from staged temp files once the run record itself is persisted
- replay data and similar follow-up metadata should be applied through `patchRun(...)`

Clients should not:

- read or write `cells/*.json` directly
- assume the filename of a cell is the run id
- treat `current-sessions.json` as canonical session data
- bypass refs by depending on the physical JSON layout of run output

## Failure model

The package is mostly fail-fast.

- malformed `session.json` throws on read
- malformed settings JSON throws on read
- malformed cell JSON throws when a store loads the session
- missing staged prompt-image files during promotion throw rather than silently dropping the attachment

That is the right bias for a persistence package. Silent partial recovery would make debugging storage corruption much harder.

## Testing strategy

The package tests should prove two things:

1. the persistence contract is correct
2. a client author can learn how to use the package by reading the tests

Current package tests are strongest when they behave like contract examples:

- [packages/store/tests/client-workflow.test.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/store/tests/client-workflow.test.ts)
  End-to-end usage example for session metadata, run persistence, traversal, refs, and patching.
- [packages/store/tests/session-store.test.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/store/tests/session-store.test.ts)
  Core storage, reload, traversal, replay-event, and prompt-image persistence behavior.
- [packages/store/tests/stored-sessions.test.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/store/tests/stored-sessions.test.ts)
  Session metadata parsing and listing behavior.
- [packages/store/tests/session-cleanup.test.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/store/tests/session-cleanup.test.ts)
  Cleanup classification behavior.
- [packages/store/tests/settings.test.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/store/tests/settings.test.ts)
  Settings parsing failure behavior.

The right standard for future tests is: if a new client capability depends on the store package, the first place a reader should be able to learn that capability is a store-package test.

## Current Review Metrics

Measured during the 2026-05 store boundary review:

- source files: 13
- source lines: 1,886
- largest file: `src/session-store.ts` at 509 lines
- runtime value exports: 24 -> 23
- public wildcard exports: 0
- code simplification applied: made `formatTimestamp(...)` a module-private
  helper behind the public session-picker formatting functions
  and split session record/result shaping into private `session-records.ts`.
