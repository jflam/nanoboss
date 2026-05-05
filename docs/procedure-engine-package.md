# `@nanoboss/procedure-engine`

`@nanoboss/procedure-engine` is the execution layer between procedure definitions and the runtime/frontends that invoke them.

It owns:

- top-level procedure execution and resume semantics
- the concrete `ProcedureApi` implementation exposed to procedures
- downstream-agent session policy as seen from procedure code
- durable run/result shaping on top of `@nanoboss/store`
- async procedure dispatch jobs, recovery, and progress forwarding
- procedure-scoped UI event formatting helpers used by frontends

It does not own:

- procedure discovery itself
- downstream ACP protocol mechanics
- durable store implementation details
- frontend rendering policy

Those boundaries matter:

- `@nanoboss/procedure-catalog` finds and registers procedures.
- `@nanoboss/agent-acp` talks to downstream agents.
- `@nanoboss/store` persists runs, refs, and session metadata.
- `@nanoboss/app-runtime` decides when to call this package and how to surface results to CLI/HTTP/MCP clients.

## Mental model

There are two main ways this package is used.

### 1. Direct top-level procedure execution

The public entrypoint is [packages/procedure-engine/src/index.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/procedure-engine/src/index.ts:1).

Callers normally use:

- `executeProcedure(...)`

That is the root-run orchestrator in [procedure-runner.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/procedure-engine/src/procedure-runner.ts:78).

Use this path when you already resolved the `Procedure`, have a `SessionStore`, and want to execute it inside an existing nanoboss session.

### 2. Async background dispatch

The async dispatch surface lives in:

- [packages/procedure-engine/src/dispatch/jobs.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/procedure-engine/src/dispatch/jobs.ts:1)
- [packages/procedure-engine/src/dispatch/recovery.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/procedure-engine/src/dispatch/recovery.ts:1)
- [packages/procedure-engine/src/dispatch/progress.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/procedure-engine/src/dispatch/progress.ts:1)

Use this path when a procedure should run in the background and a frontend wants queued/running/completed status plus streamed progress.

The central type is `ProcedureDispatchJobManager`.

## Package structure

### Execution core

- [src/procedure-runner.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/procedure-engine/src/procedure-runner.ts:1)
  Owns top-level run lifecycle, root `CommandContextImpl` creation, cancellation/error normalization, and final `RunResult` shaping.
- [src/run-result.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/procedure-engine/src/run-result.ts:1)
  Converts stored runs into public `RunResult` values.
- [src/prompt.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/procedure-engine/src/prompt.ts:1)
  Normalizes prompt input into the procedure-facing prompt shape.

### Procedure-facing context

- [src/context/context.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/procedure-engine/src/context/context.ts:1)
  Concrete `ProcedureApi` implementation.
- [src/context/agent-api.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/procedure-engine/src/context/agent-api.ts:1)
  Implements `ctx.agent`.
- `src/context/agent-run-recorder.ts`
  Agent child-run persistence, logging, and tool-call event publication.
- `src/context/bound-agent-invocation.ts`
  Bound `ctx.agent.session(mode).run(...)` wrapper.
- `src/context/agent-output-events.ts`
  Internal structured-output panel formatting and nested agent update metadata helpers.
- `src/context/named-refs.ts`
  Internal named ref resolution for `ctx.agent.run(...)` inputs.
- `src/context/type-descriptor.ts`
  Shared runtime guard for procedure-sdk type descriptors.
- [src/context/procedure-api.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/procedure-engine/src/context/procedure-api.ts:1)
  Implements `ctx.procedures`.
- [src/context/session-api.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/procedure-engine/src/context/session-api.ts:1)
  Implements `ctx.session`, including default/fresh/inherit session binding behavior.
- [src/context/state-api.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/procedure-engine/src/context/state-api.ts:1)
  Implements `ctx.state`.
- [src/context/ui-api.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/procedure-engine/src/context/ui-api.ts:1)
  Implements `ctx.ui`.
- [src/context/shared.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/procedure-engine/src/context/shared.ts:1)
  Shared emitter and UI event types.

### Dispatch and frontend helpers

- [src/dispatch/jobs.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/procedure-engine/src/dispatch/jobs.ts:1)
  Dispatch lifecycle orchestration, worker launch, wait/cancel/status reconciliation.
- `src/dispatch/job-store.ts`
  Internal JSON file persistence and reusable correlation-id lookup for dispatch jobs.
- `src/dispatch/cancellation-watcher.ts`
  Detached-worker cancellation marker polling and abort signalling.
- `src/dispatch/files.ts`
  Dispatch job/cancellation path helpers and cancellation marker writes.
- `src/dispatch/worker-args.ts`
  Detached dispatch worker CLI argument parsing.
- `src/dispatch/worker-command.ts`
  Detached dispatch worker command entrypoint and registry loading.
- `src/dispatch/worker-process.ts`
  Detached dispatch worker process spawning.
- `src/dispatch/status.ts`
  Dispatch terminal-status checks, dead-worker detection, cancellation marking,
  and status result shaping.
- `src/dispatch/wait.ts`
  Dispatch wait timeout bounds and poll interval policy.
- [src/dispatch/recovery.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/procedure-engine/src/dispatch/recovery.ts:1)
  Recovery when the outer polling path loses the terminal result.
- `src/dispatch/runtime-bindings.ts`
  Default-agent runtime binding closure for detached dispatch execution.
- [src/dispatch/progress.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/procedure-engine/src/dispatch/progress.ts:1)
  JSONL progress bridge between detached workers and live emitters.
- [src/ui-events.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/procedure-engine/src/ui-events.ts:1)
  Structured procedure UI markers and fallback text formatting.

### Shared support

- [src/agent-config.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/procedure-engine/src/agent-config.ts:1)
  Session-aware downstream-agent selection/config resolution.
- [src/logger.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/procedure-engine/src/logger.ts:1)
  Per-run JSONL trace logging.
- `@nanoboss/app-support`
  Owns self-command resolution used by dispatch workers and the shared
  structured timing trace writer.
- `@nanoboss/procedure-sdk`
  Owns compact data-shape helpers used by run-result and recovery code.

## How the CLI reaches this package

The `nanoboss` binary does not call this package directly for normal foreground command execution. The call chain is:

1. [nanoboss.ts](/Users/jflam/agentboss/workspaces/nanoboss/nanoboss.ts:1) parses the top-level subcommand.
2. `nanoboss cli` goes to [cli.ts](/Users/jflam/agentboss/workspaces/nanoboss/cli.ts:1).
3. `cli.ts` launches the TUI adapter.
4. The TUI frontend talks to app runtime services.
5. [packages/app-runtime/src/service.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/app-runtime/src/service.ts:1) eventually calls `executeProcedure(...)`.

The relevant foreground call site is here:

- [packages/app-runtime/src/service.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/app-runtime/src/service.ts:868)

That is the main integration point for direct slash-command execution.

The CLI does call this package directly for the internal worker entrypoint:

- `nanoboss procedure-dispatch-worker`
- routed by [nanoboss.ts](/Users/jflam/agentboss/workspaces/nanoboss/nanoboss.ts:56)
- implemented by [runProcedureDispatchWorkerCommand(...)](/Users/jflam/agentboss/workspaces/nanoboss/packages/procedure-engine/src/dispatch/worker-command.ts:6)

So the package has two runtime-facing roles:

- foreground execution engine for app-runtime
- detached worker implementation for async dispatch

## How app-runtime uses it

`@nanoboss/app-runtime` is the main package that composes `procedure-engine` with session state, event logs, and frontend protocols.

Important integration points:

- [packages/app-runtime/src/service.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/app-runtime/src/service.ts:1)
  Uses `executeProcedure`, cancellation helpers, recovery helpers, dispatch job manager, progress bridge, and UI event types.
- [packages/app-runtime/src/default-agent-policy.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/app-runtime/src/default-agent-policy.ts:1)
  Supplies `prepareDefaultPrompt(...)`, which plugs into the engine’s default-session transport path.
- [packages/app-runtime/src/runtime-service.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/app-runtime/src/runtime-service.ts:1)
  Uses `ProcedureDispatchJobManager` and `inferDataShape(...)` for MCP/runtime APIs.

The core contract is:

- app-runtime owns session state and event publication
- procedure-engine owns execution semantics once a procedure call begins

## How to use `executeProcedure(...)`

The public API is defined in [src/index.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/procedure-engine/src/index.ts:91).

Minimum required inputs:

- `cwd`
- `sessionId`
- `store`
- `registry`
- `procedure`
- `prompt`
- `emitter`
- `getDefaultAgentConfig`
- `setDefaultAgentSelection`

Typical usage from a runtime looks like this:

```ts
const result = await executeProcedure({
  cwd,
  sessionId,
  store,
  registry,
  procedure,
  prompt,
  emitter,
  agentSession: defaultAgentSession,
  getDefaultAgentConfig: () => defaultAgentConfig,
  setDefaultAgentSelection: (selection) => {
    defaultAgentConfig = resolveDownstreamAgentConfig(cwd, selection);
    defaultAgentSession.updateConfig(defaultAgentConfig);
    return defaultAgentConfig;
  },
  prepareDefaultPrompt,
  isAutoApproveEnabled,
  onError: (ctx, errorText) => {
    ctx.ui.text(errorText);
  },
  signal,
  softStopSignal,
  timingTrace,
});
```

Behavior of the top-level runner:

1. Starts a top-level run in `SessionStore`.
2. Builds `CommandContextImpl`.
3. Executes the procedure.
4. Normalizes the procedure result with `normalizeProcedureResult(...)`.
5. Persists the final run.
6. Returns a public `RunResult`.

The top-level runner is also where root-level selection changes are captured. It compares the default-agent selection before and after execution and persists the changed selection on the top-level run metadata.

## How to resume a procedure

Resuming uses the same `executeProcedure(...)` engine path with an extra
`resume` payload passed down to the procedure’s `resume(...)` hook.

This is the only supported way to continue a paused top-level procedure through this package. Do not call `procedure.resume(...)` directly from runtime code.

Relevant implementation:

- [packages/procedure-engine/src/procedure-runner.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/procedure-engine/src/procedure-runner.ts:78)
- [packages/app-runtime/src/service.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/app-runtime/src/service.ts:969)

## What procedure code gets from `CommandContextImpl`

Procedures do not use the engine API directly. They use the `ProcedureApi` surface implemented by [CommandContextImpl](/Users/jflam/agentboss/workspaces/nanoboss/packages/procedure-engine/src/context/context.ts:54).

The context exposes:

- `ctx.agent`
- `ctx.procedures`
- `ctx.session`
- `ctx.state`
- `ctx.ui`
- `ctx.assertNotCancelled()`

### `ctx.agent`

Implemented in [src/context/agent-api.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/procedure-engine/src/context/agent-api.ts:248).

This is the only engine-supported way for procedure code to talk to downstream agents.

Important behavior:

- `session: "default"` reuses the current default agent session when available.
- otherwise the call goes through fresh `invokeAgent(...)` behavior.
- typed calls attach `explicitDataSchema`.
- agent calls create child runs of kind `agent`.
- nested tool-call/session updates are forwarded to the parent emitter.

Guidance:

- if a procedure wants conversation continuity with the session’s main agent, use `ctx.agent.run(..., { session: "default" })`
- if it wants isolated execution, use the default `fresh` behavior
- avoid inventing a side channel for downstream agents outside this API

### `ctx.procedures`

Implemented in [src/context/procedure-api.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/procedure-engine/src/context/procedure-api.ts:38).

This is the only engine-supported way for one procedure to invoke another.

Session binding rules come from [src/context/session-api.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/procedure-engine/src/context/session-api.ts:94):

- `inherit`
  Reuse the current procedure’s binding.
- `default`
  Rebind to the root default session.
- `fresh`
  Create a private fresh default-session binding for the child procedure only.

That last mode is how a child procedure can have its own mutable “default” downstream conversation without mutating the caller’s root session.

### `ctx.session`

Implemented by `ContextSessionApiImpl`.

It owns live default-session policy:

- get current default agent config
- set default agent selection
- inspect default-session token usage
- determine auto-approve state

This is intentionally separate from `ctx.state`.

### `ctx.state`

Implemented in [src/context/state-api.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/procedure-engine/src/context/state-api.ts:1).

It owns durable state access:

- read refs
- stat refs
- write refs to files
- list runs
- fetch runs
- inspect ancestors/descendants

Rule of thumb:

- `ctx.session` is for live execution policy
- `ctx.state` is for durable recorded state

### `ctx.ui`

Implemented in [src/context/ui-api.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/procedure-engine/src/context/ui-api.ts:17).

It supports:

- `text(...)`
- `info(...)`
- `warning(...)`
- `error(...)`
- `status(...)`
- `card(...)`

If the emitter supports `emitUiEvent(...)`, structured procedure UI events are sent. Otherwise the engine falls back to text output using the shared marker/text helpers in [src/ui-events.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/procedure-engine/src/ui-events.ts:1).

## Async dispatch model

The dispatch job manager persists job state under the session root directory:

- `procedure-dispatch-jobs/`
- `procedure-dispatch-cancels/`
- `procedure-dispatch-progress/`
- `timing-traces/`

The flow is:

1. `ProcedureDispatchJobManager.start(...)` validates the procedure and writes a queued job.
2. It spawns a detached worker using `resolveSelfCommand(...)`.
3. The worker re-enters `nanoboss procedure-dispatch-worker`.
4. `manager.run(dispatchId)` loads the job and runs the procedure with `executeProcedure(...)`.
5. Progress updates are appended to a JSONL progress file.
6. A foreground runtime can bridge those updates back into its live emitter with `startProcedureDispatchProgressBridge(...)`.
7. If the prompt/transport path loses the terminal result, recovery helpers can rediscover the stored run by `dispatchCorrelationId`.

Important source references:

- job lifecycle: [dispatch/jobs.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/procedure-engine/src/dispatch/jobs.ts:98)
- progress bridge: [dispatch/progress.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/procedure-engine/src/dispatch/progress.ts:17)
- recovery scan/sync prompt: [dispatch/recovery.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/procedure-engine/src/dispatch/recovery.ts:16)

## Single-path guidance

If the goal is to keep behavior centralized and avoid duplicate execution semantics, runtime code should follow these rules:

1. Use `executeProcedure(...)` for top-level execution and pass its `resume` payload for resume.
2. Use `ctx.procedures.run(...)` for nested procedure calls.
3. Use `ctx.agent.run(...)` for downstream agent calls.
4. Use `ProcedureDispatchJobManager` for async/background procedure execution.
5. Use `startProcedureDispatchProgressBridge(...)` for replaying worker progress into a live frontend.
6. Use recovery helpers from `dispatch/recovery.ts` instead of inventing ad hoc “find the stored result” scans.

Avoid:

- calling `procedure.execute(...)` directly from runtime code
- calling `procedure.resume(...)` directly from runtime code
- spawning dispatch workers manually without `ProcedureDispatchJobManager`
- bypassing `ctx.agent` with custom agent-acp wiring inside a procedure
- mixing `ctx.session` concerns with `ctx.state` durable traversal

## Tests worth reading

The package’s own tests are under [packages/procedure-engine/tests](/Users/jflam/agentboss/workspaces/nanoboss/packages/procedure-engine/tests).

The strongest execution-path coverage is:

- [packages/procedure-engine/tests/procedure-engine-package.test.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/procedure-engine/tests/procedure-engine-package.test.ts:254)
  Top-level run, nested procedure, pause/resume, recovery, cancellation, and typed-agent shaping.
- [packages/procedure-engine/tests/context-ui.test.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/procedure-engine/tests/context-ui.test.ts:20)
  Procedure UI emission behavior.
- [tests/unit/context-call-agent-session.test.ts](/Users/jflam/agentboss/workspaces/nanoboss/tests/unit/context-call-agent-session.test.ts:40)
  Session-mode behavior across nested procedures and default-session agent calls.
- [tests/unit/procedure-dispatch-jobs.test.ts](/Users/jflam/agentboss/workspaces/nanoboss/tests/unit/procedure-dispatch-jobs.test.ts:74)
  Dispatch worker death and cancellation behavior.

## Current design summary

The refactor succeeded if you view this package as the single execution authority for:

- procedure lifecycle
- procedure-facing context behavior
- session-binding semantics inside procedure execution
- async procedure dispatch orchestration

The neighboring packages should remain simpler because of that split:

- catalog packages discover procedures
- store persists durable data
- agent-acp talks ACP
- app-runtime decides when to invoke the engine and how to surface the result

If new execution logic is added outside these paths, that is usually a sign that the behavior belongs back in `@nanoboss/procedure-engine`.

## Current Review Metrics

Measured during the 2026-05 compatibility re-export review:

- source files: 33
- source lines: 3,209
- largest file: `src/dispatch/jobs.ts` at 465 lines
- runtime value exports: 36 -> 30
- public wildcard exports: 0
- code simplification applied: removed compatibility re-exports for data-shape
  helpers and self-command helpers; centralized the duplicated timing trace
  writer and public timing trace imports in `@nanoboss/app-support`
- code simplification applied: split the detached dispatch worker command and
  disk registry loading out of the job manager module
- code simplification applied: split detached worker process spawning out of
  the job manager module
- code simplification applied: split dispatch wait timing policy out of the
  job manager module
- code simplification applied: split detached-worker cancellation polling out
  of the job manager module
- code simplification applied: split detached dispatch runtime bindings out of
  the job manager module
- code simplification applied: split named ref resolution out of the agent API
  implementation module
- code simplification applied: split bound agent session invocation and the
  shared type-descriptor guard out of the agent API implementation module
- code simplification applied: split agent child-run recording and event
  publication out of the agent API implementation module
