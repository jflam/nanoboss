# Library Refactor Plan

## Purpose

This plan describes a simple way to refactor nanoboss into a small set of
independent libraries.

The key idea is:

1. simplify the ontology first
2. define the target type families explicitly
3. extract libraries around those simplified type families

Do not start by moving folders around.

## Refactor Posture

This refactor should optimize for simplification, not backward compatibility.

The goal is to do one large cleanup that:

- removes duplicate public concepts
- removes overlapping type families
- removes accidental package boundaries
- leaves nanoboss as a thin wrapper over a few clean libraries

The default move is:

- rename aggressively
- delete duplicate public names
- keep old names only when they are strictly useful as local implementation
  details during the refactor

For this refactor, the default move should be elimination rather than aliasing.

If two public names currently refer to the same concept:

- pick one canonical name
- move the implementation behind that name
- remove the other from the new surface

Do not carry duplicate naming into the library split unless there is a strong,
durable reason that the concepts are actually different.

## Core Approach

The mistake to avoid is extracting current shapes into packages unchanged.

Instead, each major concept cluster should be handled with the same exercise:

1. list the current types
2. identify the one canonical concept
3. decide which distinctions are real and should survive
4. delete distinctions that are only naming noise
5. write the target post-refactor type family
6. extract a library around that simplified family

This is the main execution model for the whole refactor.

## The Five Concept Families

The refactor should be organized around five concept families:

1. `Run`
2. `Session`
3. `Continuation`
4. `Procedure`
5. `Agent Session`

These are the families that should shape the libraries.

## Before / After Vocabulary Table

This is the practical summary of the simplification.

### Nouns

| Current noun(s) | Problem | Canonical after noun | Decision |
| --- | --- | --- | --- |
| `Session`, `SessionMetadata`, `SessionState`, current-session index | One concept spread across runtime, durable, and index layers with no single public owner | `Session` | Keep `Session` public; treat metadata, in-memory state, and workspace index as subordinate representations |
| `Cell`, `CellRecord`, `CellSummary`, run, `RunResult`, `ProcedureExecutionResult` | One execution concept expressed through too many peer nouns | `Run` | Normalize the public surface around `Run`; keep storage-specific `cell` language internal if needed |
| `CellRef`, `ValueRef`, ref-related result fields | Pointer model is split between generic and storage-specific language | `Ref` | Treat `Ref` as the user concept; use more specific names only when the distinction is necessary |
| `ProcedurePause`, `PendingProcedureContinuation`, suggested replies, continuation UI | One paused-workflow concept exposed as multiple unrelated nouns | `Continuation` | Model pause state as one continuation concept with authored and session-bound layers |
| `Procedure`, `ProcedureMetadata`, `DeferredProcedureMetadata`, command | Runtime abstraction and UI language are mixed | `Procedure` | Use `Procedure` for the runtime abstraction; reserve `command` for user-facing menus or routing surfaces |
| `DefaultConversationSession`, `PersistentAcpSession`, persisted ACP session id | One live downstream continuity concept with ACP details leaking outward | `Agent Session` | Expose agent continuity as `Agent Session`; keep ACP-specific wrappers internal |
| `AgentTokenSnapshot`, `AgentTokenUsage` | Two related but distinct token concepts | `AgentTokenSnapshot`, `AgentTokenUsage` | Keep both; this overlap is intentional and useful |
| `SessionEventLog`, persisted replay events | Live and durable event histories can look like duplicates | `Live Event Log`, `Replay Events` | Keep both, but document them as distinct live vs durable layers |

### Verbs

| Current verb(s) | Problem | Canonical after verb(s) | Decision |
| --- | --- | --- | --- |
| `prompt`, `resume`, `load` in mixed contexts | Session and procedure operations use overlapping verbs | `createSession`, `resumeSession`, `promptSession` | Use explicit session verbs at the app-runtime boundary |
| `startCell`, `finalizeCell`, `patchCell`, run-related terminology | Storage verbs leak storage nouns | `startRun`, `completeRun`, `patchRun` publicly; storage may keep internal cell verbs temporarily | Public/query surfaces should speak in runs |
| `top_level_runs`, `session_recent`, `cell_get`, `cell_descendants`, `cell_ancestors` | Retrieval API is powerful but flat and inconsistent | `listRuns`, `getRun`, `getRunAncestors`, `getRunDescendants` | Group retrieval by concept instead of exposing a flat tool bag |
| `ref_read`, `ref_stat`, `get_schema` | Similar “inspect stored thing” operations are not grouped clearly | `readRef`, `statRef`, `getRefSchema` / `getRunSchema` | Keep ref verbs stable but place them under explicit namespaces |
| `execute`, `run`, `dispatch`, `resume` for procedures | Sync and async execution verbs can blur together | `runProcedure`, `dispatchProcedure`, `resumeProcedure` | Reserve `dispatch` for async or detached execution |
| ACP-specific session establishment verbs | Transport details can leak into core logic | `openAgentSession`, `reuseAgentSession`, `closeAgentSession`, `runAgent` | Keep ACP details internal to transport libraries |

## Step 1: Collapse The Type Families

Before creating libraries, write and agree on the target shapes for each family.

### A. Run family

Current overlap:

- `Cell`
- `CellRecord`
- `CellSummary`
- `run`
- `RunResult`
- `ProcedureExecutionResult`

Target concept:

- `Run`

Target family:

```ts
type RunKind = "top_level" | "procedure" | "agent";

interface RunRef {
  sessionId: string;
  runId: string;
}

interface RunRecord {
  run: RunRef;
  kind: RunKind;
  procedure: string;
  input: string;
  output: {
    data?: unknown;
    display?: string;
    stream?: string;
    summary?: string;
    memory?: string;
    pause?: Continuation;
  };
  meta: {
    createdAt: string;
    parentRunId?: string;
  };
}

interface RunSummary {
  run: RunRef;
  kind: RunKind;
  procedure: string;
  createdAt: string;
  summary?: string;
  dataRef?: Ref;
  displayRef?: Ref;
  streamRef?: Ref;
}

interface RunResult {
  run: RunRef;
  summary?: string;
  dataRef?: Ref;
  displayRef?: Ref;
  streamRef?: Ref;
  pause?: Continuation;
  tokenUsage?: AgentTokenUsage;
  defaultAgentSelection?: DownstreamAgentSelection;
}
```

Decision:

- `Run` is public
- `cell` becomes internal storage language only
- public APIs should stop teaching `cell` and `run` as separate concepts

### B. Session family

Current overlap:

- `Session`
- `SessionMetadata`
- live `SessionState`
- current-session index

Target concept:

- `Session`

Target family:

```ts
interface SessionRef {
  sessionId: string;
}

interface SessionDescriptor {
  session: SessionRef;
  cwd: string;
  defaultAgentSelection?: DownstreamAgentSelection;
}

interface SessionMetadata {
  session: SessionRef;
  cwd: string;
  rootDir: string;
  createdAt: string;
  updatedAt: string;
  defaultAgentSelection?: DownstreamAgentSelection;
  defaultAgentSessionId?: string;
  pendingContinuation?: PendingContinuation;
}
```

Decision:

- `Session` is public
- live runtime session state stays internal to the app runtime
- the workspace current-session index stays internal to storage/runtime

### C. Continuation family

Current overlap:

- `ProcedurePause`
- `PendingProcedureContinuation`
- suggested replies
- `ProcedureContinuationUi`

Target concept:

- `Continuation`

Target family:

```ts
interface Continuation {
  question: string;
  state: unknown;
  inputHint?: string;
  suggestedReplies?: string[];
  ui?: ContinuationUi;
}

interface PendingContinuation extends Continuation {
  procedure: string;
  run: RunRef;
}
```

Decision:

- one public continuation concept
- authored pause payload and session-routed pending continuation remain distinct
- suggested replies and structured UI are affordances on the same concept

### D. Procedure family

Current overlap:

- `Procedure`
- `ProcedureMetadata`
- `DeferredProcedureMetadata`
- command terminology

Target concept:

- `Procedure`

Target family:

```ts
interface ProcedureMetadata {
  name: string;
  description: string;
  inputHint?: string;
}

interface Procedure {
  name: string;
  description: string;
  inputHint?: string;
  execute(prompt: string, ctx: ProcedureApi): Promise<ProcedureResult>;
  resume?(
    prompt: string,
    state: unknown,
    ctx: ProcedureApi,
  ): Promise<ProcedureResult>;
}
```

Decision:

- `Procedure` is the runtime abstraction
- `command` is only a user-surface term where necessary

### E. Agent Session family

Current overlap:

- `DefaultConversationSession`
- `PersistentAcpSession`
- persisted ACP session id

Target concept:

- `Agent Session`

Target family:

```ts
interface AgentSession {
  sessionId?: string;
  prompt(...): Promise<AgentRunResult>;
  warm?(): Promise<void>;
  close(): void;
}
```

Decision:

- the public/runtime-facing concept is `AgentSession`
- ACP-specific wrapper types stay internal to the ACP implementation library

## Step 2: Build The Libraries Around The Collapsed Families

After the target type families are agreed, extract the libraries.

Only create a library when its main type family is already simplified.

### `@nanoboss/contracts`

Purpose:

- hold the simplified public ontology

Should contain:

- `Run*`
- `Session*`
- `Continuation*`
- `Procedure*`
- `AgentSession` interface
- `Ref` types

Rule:

- no HTTP, MCP, ACP, TUI, filesystem, or Bun-specific imports

### `@nanoboss/store`

Purpose:

- own durable storage for sessions, runs, and refs

Should contain:

- filesystem-backed session repository
- filesystem-backed run store
- run traversal and ref access

Rule:

- public outward-facing contracts should use `Run`, not `Cell`
- `cell` may remain as an internal implementation term

### `@nanoboss/procedure-sdk`

Purpose:

- expose the stable author-facing procedure API

Should contain:

- `Procedure`
- `ProcedureApi`
- `ProcedureResult`
- `RunResult`
- helper types and stable author-facing utilities

Rule:

- built-ins and generated procedures should import from this package, not from
  repo internals

### `@nanoboss/procedure-catalog`

Purpose:

- own procedure registration, discovery, loading, and persistence

### `@nanoboss/procedure-engine`

Purpose:

- execute procedures against the simplified run/session model

Should contain:

- top-level procedure execution
- child procedure execution
- pause/resume
- cancellation boundaries

Rule:

- no HTTP/MCP/TUI/ACP event types

### `@nanoboss/agent-acp`

Purpose:

- implement the `AgentSession` concept over ACP

Should contain:

- ACP connection management
- typed parse/retry
- default-session reuse
- token snapshot collection

### `@nanoboss/app-runtime`

Purpose:

- own live session coordination and application policy

Should contain:

- session create/resume
- active run coordination
- replay/recovery
- pending continuation routing
- async dispatch

### Adapter libraries

These should be thin and come last:

- `@nanoboss/adapters-http`
- `@nanoboss/adapters-mcp`
- `@nanoboss/adapters-acp-server`
- `@nanoboss/adapters-tui`

## Step 3: Use One Repeated Migration Pattern

For each concept family and then each library, use this sequence:

1. define the target types
2. rename the code to those types
3. delete duplicate names
4. move the code behind a clean package boundary
5. add isolated tests for the new package

This should be done family-by-family, not as one giant package split.

## Recommended Work Order

### Phase 1: Run family

Why first:

- this is the biggest vocabulary tax in the codebase
- it affects storage, runtime queries, execution results, and MCP APIs

Output:

- canonical `Run` family
- public run terminology
- internal decision about where `cell` still exists locally

### Phase 2: Session family

Why second:

- it defines what the app runtime actually owns
- it cleans up session metadata vs live session state

Output:

- canonical session types
- clear boundary between durable metadata and live runtime state

### Phase 3: Continuation family

Why third:

- it cuts through service, repository, and frontend complexity

Output:

- canonical continuation types
- simplified pending continuation model

### Phase 4: Procedure family

Why fourth:

- it stabilizes the public authoring surface

Output:

- clean procedure SDK contracts
- cleaner procedure catalog contracts

### Phase 5: Agent Session family

Why fifth:

- it clarifies what the downstream transport actually implements

Output:

- runtime-facing `AgentSession` contract
- ACP-specific internals kept behind the transport library

### Phase 6: Extract libraries in this order

1. `@nanoboss/contracts`
2. `@nanoboss/store`
3. `@nanoboss/procedure-sdk`
4. `@nanoboss/procedure-catalog`
5. `@nanoboss/procedure-engine`
6. `@nanoboss/agent-acp`
7. `@nanoboss/app-runtime`
8. adapters

## Test Strategy

Keep this simple.

Each library should have tests that match its role.

### `@nanoboss/contracts`

- compile and shape tests

### `@nanoboss/store`

- run graph tests
- ref tests
- session metadata tests

### `@nanoboss/procedure-sdk`

- consumer-style compile tests

### `@nanoboss/procedure-catalog`

- fixture-based discovery and loading tests

### `@nanoboss/procedure-engine`

- fake-based execution tests

### `@nanoboss/agent-acp`

- mocked protocol tests

### `@nanoboss/app-runtime`

- session lifecycle and recovery tests

### adapters

- thin serialization and mapping tests only

## Definition Of Done

This refactor is successful if:

- the public ontology is small and consistent
- `Run` replaces the public `cell`/`run` split
- `Session` replaces multiple public session nouns
- `Continuation` is one clear concept
- procedures use a real SDK instead of importing repo internals
- nanoboss entrypoints mostly wire libraries together

## Immediate Next Step

Do not start extracting packages yet.

Start by writing the concrete target type families for:

1. `Run`
2. `Session`
3. `Continuation`
4. `Procedure`
5. `Agent Session`

Once those are agreed, use them to drive the package extraction.
