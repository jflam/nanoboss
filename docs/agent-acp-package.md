# `@nanoboss/agent-acp`

`@nanoboss/agent-acp` is nanoboss's downstream-agent integration package. It owns the ACP-facing mechanics for talking to Claude, Codex, Copilot, Gemini, or another ACP-capable child process over stdio, and it presents those mechanics as two client-facing execution models:

- a persistent `AgentSession` for the session's reusable default conversation
- fresh one-off calls through `invokeAgent(...)`

This package is the authority for:

- spawning and initializing downstream ACP child processes
- creating or loading ACP sessions
- applying downstream session config such as model and reasoning effort
- converting nanoboss `PromptInput` values to and from ACP content blocks
- collecting streamed ACP updates and deriving plain-text output
- guarding nanoboss's own runtime files from recursive downstream access
- opportunistically collecting provider-specific token metrics
- exposing the shared harness-discovered downstream model catalog used elsewhere in the product

This package is not responsible for:

- deciding which downstream agent a nanoboss session should use by policy
- persisting nanoboss session metadata or run graphs as a system of record
- procedure execution, procedure discovery, or top-level command routing
- frontend event formatting for TUI, HTTP, or ACP server clients
- interpreting procedure-level business logic

## Mental model

There are two distinct ways to use this package.

### 1. Persistent default conversation

Use `createAgentSession(...)` when the caller wants one logical downstream conversation that can survive multiple prompts.

- The package keeps at most one live ACP child/session behind that `AgentSession`.
- If the child dies or the client closes it, the package tries `session/load` with the persisted ACP session id.
- If native load is unavailable or fails, it falls back to a fresh ACP session.
- `updateConfig(...)` is a continuity boundary. A materially different config closes the old session and clears the persisted ACP session id.

This is the path used by the runtime's default downstream conversation.

### 2. Fresh isolated calls

Use `invokeAgent(...)` when the caller wants a fresh subprocess/session per call.

- `invokeAgent(...)` is the transport-level API.

Unless `persistedSessionId` is provided, these calls do not reuse prior downstream context.

## Public surface

The public entrypoint is [packages/agent-acp/src/index.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/agent-acp/src/index.ts).

The surface breaks down into a few groups.

### 1. Session and invocation APIs

- `createAgentSession(...)`
- `invokeAgent(...)`

These are the core client APIs.

Use `createAgentSession(...)` for a reusable downstream conversation.

Use `invokeAgent(...)` when the caller wants raw transport results:

- `raw`
- `updates`
- `logFile`
- `tokenSnapshot`
- `agentSessionId`

### 2. Prompt and update helpers

- `promptInputToAcpBlocks(...)`
- `promptInputFromAcpBlocks(...)`
- `summarizePromptInputForAcpLog(...)`
- `collectTextSessionUpdates(...)`
- `parseAssistantNoticeText(...)`
- `summarizeAgentOutput(...)`

These define how nanoboss prompt inputs and streamed updates map to ACP wire data and to user-visible text.

### 3. Runtime/config helpers

- `resolveDefaultDownstreamAgentConfig(...)`
- `getNanobossHome()`
- `getAgentTranscriptDir()`
- `buildAgentRuntimeSessionRuntime(...)`
- `setAgentRuntimeSessionRuntimeFactory(...)`
- `describeBlockedNanobossAccess(...)`

Important boundary:

- `resolveDefaultDownstreamAgentConfig(...)` is only the env/default-command resolver owned by this package.
- Higher-level session-aware selection policy, including persisted default-agent selection, lives in `procedure-engine` and `store`, not here.

### 4. Token and model helpers

- token usage helpers from `token-usage.ts`
- `collectTokenSnapshot(...)` for best-effort provider token snapshots
- model catalog helpers from `model-catalog.ts` and `catalog-discovery.ts`

Provider-specific log parsers such as Claude debug parsing and Copilot log
parsing are private `token-metrics.ts` implementation details covered through
`collectTokenSnapshot(...)`; they are not package entrypoint APIs.

The model catalog is discovered from the installed ACP harness for the effective
provider config, with a short-lived cache to avoid reprobing on every caller
action. Callers should treat it as a recent, environment-dependent view of what
the harness currently advertises rather than as a permanently hard-coded list:
results can differ by provider capabilities, account access, and harness
version, and refresh failures are surfaced to callers instead of silently
falling back to a full static catalog.

These are shared support utilities for downstream-agent UX, but they are secondary to the session/invocation APIs.

## Interface contract

The public types are assembled from:

- `@nanoboss/contracts`
- `@nanoboss/procedure-sdk`
- [packages/agent-acp/src/types.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/agent-acp/src/types.ts)

The important types are:

- `DownstreamAgentConfig`
  The concrete spawn/configuration contract for a downstream ACP child.
- `PromptInput`
  The structured prompt payload that may contain text and images.
- `AgentSession`
  A reusable downstream conversation handle.
- `CallAgentOptions`
  Options shared by fresh one-off invocations.
- `AgentTokenSnapshot` and `AgentTokenUsage`
  Opportunistic token/accounting metadata, not a guaranteed transport field.

Important invariants:

- One `AgentSession` represents one logical downstream conversation.
- `AgentSession.prompt(...)` is single-flight.
  Overlapping prompts on the same session are rejected instead of trying to multiplex two turns through one collector.
- A material `updateConfig(...)` change resets conversation continuity.
- Fresh `invokeAgent(...)` calls create a new child/session unless `persistedSessionId` is supplied.
- `agentSessionId` is the ACP session id for the downstream agent, not the nanoboss session id.
- Typed calls retry parsing with corrective follow-up prompts before surfacing a contract failure.
- Token metrics are best-effort. Clients must not depend on them being present.

## Runtime and on-disk model

At runtime, the package talks to downstream agents as child processes over ACP ndjson on stdio.

For each child process, the package writes a transcript log under:

```text
~/.nanoboss/agent-logs/<uuid>.jsonl
```

That transcript is package-owned diagnostic output for the downstream ACP exchange. It is not the durable nanoboss session store.

For token metrics, the package may also read provider-owned local files:

- `~/.claude/debug/<acp-session-id>.txt`
- `~/.copilot/logs/process-*.log`
- `~/.copilot/session-state/<acp-session-id>/events.jsonl`

Those files are inputs to best-effort token accounting only. They are not part of the package's durable public contract.

## How callers should use it

### Reusable default conversation

```ts
const session = createAgentSession({ config });
await session.warm?.();

const first = await session.prompt("what is 2+2");
const second = await session.prompt("add 3 to result");
const acpSessionId = session.sessionId;
```

Use this model when a caller wants downstream conversational continuity.

### Fresh isolated call

```ts
const first = await invokeAgent("what is 2+2", undefined, { config });
const second = await invokeAgent("add 3 to result", undefined, {
  config,
  persistedSessionId: first.agentSessionId,
});
```

Use this model when a caller wants isolated child sessions by default, but may choose to resume a specific downstream ACP session explicitly.

Boundary note:

- if a caller wants fresh transport behavior, use `invokeAgent(...)`
- if a caller wants persistent downstream continuity, use `createAgentSession(...)`

### Image prompts

Current first-cut support is intentionally narrower than plain text:

- default-session reuse supports image prompts only when the downstream agent advertises ACP image support
- fresh typed calls and fresh calls with named refs reject image prompts
- fresh one-off transport without default-session reuse also rejects images

Clients should treat image support as mode-dependent, not package-wide.

## Failure model

The package is intentionally fail-fast for transport and contract issues.

- spawn or ACP initialize failure throws
- unsupported image prompt usage throws
- `persistedSessionId` on a fresh call throws if the downstream agent does not support `session/load`
- invalid typed output throws after parse retries are exhausted
- blocked downstream access to `~/.nanoboss/agent-logs` or broad `~/.nanoboss` shell scans is denied during permission handling
- `AgentSession.prompt(...)` throws if the session is unavailable or another prompt is already in flight

Default-session continuity is best-effort rather than strict:

- if reloading a persisted ACP session fails, `createAgentSession(...)` falls back to a fresh session
- token metrics may be absent even when the downstream call itself succeeded

Clients should code to that split:

- transport errors and contract misuse are hard failures
- continuity reload and token accounting are opportunistic

## Ownership boundaries with neighboring packages

- `@nanoboss/procedure-engine` owns session policy, procedure-facing APIs, and how downstream agent calls are surfaced to runtime/frontend clients.
- `@nanoboss/store` owns durable nanoboss session state and refs.
- `@nanoboss/agent-acp` owns the downstream ACP conversation mechanics that those packages build on.

## Executable examples

The strongest package-level usage examples are in [packages/agent-acp/tests/agent-acp-package.test.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/agent-acp/tests/agent-acp-package.test.ts).

## Current Review Metrics

Measured during the 2026-05 agent-acp boundary reviews:

- source files: 21
- source lines: 3,597
- largest file: `src/session.ts` at 485 lines
- runtime value exports: 51 -> 31
- public wildcard exports: 0
- code simplification applied:
  - removed provider-specific token parser helpers from the package entrypoint
    while keeping direct source-level tests for those parser seams
  - removed model-selection parser/constants that are only used by
    `agent-acp` implementation modules from the package entrypoint
  - removed typed-response prompt/parser helpers from the package entrypoint
    while keeping behavior coverage through the public `invokeAgent(...)` API
  - centralized the duplicated timing trace writer in `@nanoboss/app-support`
  - removed provider-taking model catalog wrappers; callers use refreshed
    catalog-aware helpers for selection checks and option lookup
  - internalized the reasoning model selection string builder behind model
    option construction
  - internalized token-usage enrichment behind session/transport behavior while
    keeping `collectTokenSnapshot(...)` public for diagnostics
  - split model catalog discovery cache/persistence into a private helper while
    keeping refresh APIs unchanged
  - split Copilot process-log discovery out of token metric parsing and
    snapshot merging
  - split default-session model/reasoning config RPCs out of session lifecycle
    code
  - split ACP usage/prompt-response token snapshot merging and raw-output
    enrichment out of provider log collection
  - split default-agent config equality out of session lifecycle code

Those tests demonstrate:

- reusable default-session continuity
- token snapshot preservation across session close/reload
- fresh isolated calls with explicit ACP session reuse through `agentSessionId`
- late ACP update settling before a fresh transport closes
- the single-flight invariant on `AgentSession.prompt(...)`
