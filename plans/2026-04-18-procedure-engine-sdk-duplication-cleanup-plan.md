# Procedure Engine/SDK Duplication Cleanup Plan

## Goal

Eliminate duplicate code paths across `@nanoboss/procedure-sdk`, `@nanoboss/procedure-engine`, `@nanoboss/procedure-catalog`, and `@nanoboss/agent-acp` so that every logical operation has exactly one home and exactly one legitimate import path. Minimise the surface on which a future agent writing against these APIs could pick a "wrong but working" path and silently accumulate drift.

Target post-change invariants:

- Each SDK symbol (`RunCancelledError`, `formatErrorMessage`, `summarizeText`, `defaultCancellationMessage`, `normalizeRunCancelledError`) is importable from exactly one package: `@nanoboss/procedure-sdk`.
- There is exactly one public entry point that runs a procedure at the top-level boundary.
- There is one emitter interface used by every dispatch path.
- The `current` / `root` session binding fan-out is one struct, threaded once.
- Cancellation normalisation against `(signal, softStopSignal)` is one helper, called from every site.
- `ProcedureRegistryLike` in the SDK contains only what the engine consumes; disk-load / persist / builtins live in `@nanoboss/procedure-catalog`.
- Reasoning-effort model parsing lives in `@nanoboss/agent-acp`, not in the engine.
- Test-only engine classes (`CommandContextImpl`, `RunLogger`) live behind a `@nanoboss/procedure-engine/testing` subpath, not on the main entrypoint.

The changes are mechanical and refactoring-only. No new behavior. All existing tests must pass unchanged (or with minimally adjusted imports).

## Design decision: embrace ACP, drop false abstractions

The engine is already ACP-specific in substance: it depends on `@nanoboss/agent-acp`, `SessionUpdateEmitter` uses ACP `SessionUpdate` shapes, and `ContextSessionApiImpl` instantiates ACP sessions directly via `createAgentSession`. The parallel wrapper types (`ProcedureEngineAgentSession`, `ProcedureEngineAgentSessionPromptOptions`, `ProcedureEngineAgentSessionPromptResult`, `ProcedureEngineEmitter`, `PreparedProcedurePrompt`) are false abstractions — each has exactly one implementation and is never substituted.

**Decision for this plan:** embrace ACP. Replace the wrapper types with the real `AgentSession`, `AgentSessionPromptOptions`, `AgentSessionPromptResult`, and the ACP-aware `SessionUpdateEmitter` directly. If a non-ACP transport is ever needed, introduce a real transport adapter layer at that point — not speculative wrappers now.

The executing agent should not reintroduce parallel "engine-facing" interfaces for agent transport during this refactor.

## Scope

This plan covers eight items. Seven were identified during the 2026-04-18 factoring analysis; an eighth (testing subpath split) was added from a parallel analysis. Each item is independently shippable; they can be landed as separate commits in the listed order. Item 1 is a prerequisite for several of the others because it removes the dual import paths that currently mask who-owns-what.

Out of scope:

- Merging nested procedure invocation (`ProcedureInvocationApiImpl.run`) into the top-level runner. See [Follow-ups](#follow-ups).
- Moving `procedure-catalog/src/builtins.ts` (the hard-coded app procedure list) into `app-runtime`. See [Follow-ups](#follow-ups).
- Any change to on-disk procedure authoring APIs beyond the imports listed here.

## Plan

### 1. Collapse engine pass-through re-exports of SDK symbols

Today `RunCancelledError`, `defaultCancellationMessage`, `normalizeRunCancelledError`, `formatErrorMessage`, and `summarizeText` are each reachable from two import paths: `@nanoboss/procedure-sdk` and `@nanoboss/procedure-engine`. The engine versions are one-line re-exports. Engine internals inconsistently pick one or the other. This is the single largest source of "two code paths" risk.

Concrete work:

- delete [packages/procedure-engine/src/cancellation.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/procedure-engine/src/cancellation.ts:1) (1-line pass-through)
- delete [packages/procedure-engine/src/error-format.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/procedure-engine/src/error-format.ts:1) (1-line pass-through)
- delete [packages/procedure-engine/src/text.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/procedure-engine/src/text.ts:1) (1-line pass-through)
- remove the matching re-exports from [packages/procedure-engine/src/index.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/procedure-engine/src/index.ts:71) (the `cancellation`, `error-format` blocks)
- update every engine internal file that currently imports from `../cancellation.ts`, `../error-format.ts`, `../text.ts` or `./cancellation.ts` etc. to import from `@nanoboss/procedure-sdk` directly
- update every external consumer (`app-runtime`, `adapters-*`, tests) that imports these symbols from `@nanoboss/procedure-engine` to import them from `@nanoboss/procedure-sdk`
- rerun `bun test` and `bun run typecheck` workspace-wide

Acceptance criteria:

- `rg "from \"@nanoboss/procedure-engine\"" packages` returns zero matches that import `RunCancelledError`, `defaultCancellationMessage`, `normalizeRunCancelledError`, `formatErrorMessage`, `summarizeText`, or `RunCancellationReason`
- no file at `packages/procedure-engine/src/{cancellation,error-format,text}.ts`
- all package tests pass

### 2. Collapse `runProcedure`/`resumeProcedure` into a single `executeProcedure`

[packages/procedure-engine/src/index.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/procedure-engine/src/index.ts:172) defines `runProcedure` and `resumeProcedure` as 10-line wrappers around the internal `executeTopLevelProcedure`, whose sole purpose is to silence `as` casts on `agentSession` and `timingTrace`. Those casts exist because `ProcedureEngineAgentSession` and `@nanoboss/agent-acp`'s `AgentSession` are parallel duck-typed interfaces with exactly one implementation each.

Caller analysis (as of 2026-04-18):

- `runProcedure` / `resumeProcedure` → only [packages/app-runtime/src/service.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/app-runtime/src/service.ts:868) calls them (top-level boundary).
- `executeTopLevelProcedure` → only [packages/procedure-engine/src/dispatch/jobs.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/procedure-engine/src/dispatch/jobs.ts:275) calls it (dispatch worker, also a top-level boundary).
- Nested procedure invocation goes through `ProcedureInvocationApiImpl.run`, **not** this function.

There is therefore exactly one semantic caller class today: "execute at the top-level boundary." A `topLevel: boolean` flag would always be `true` and has no second caller to justify it. Rename accordingly and drop the wrappers.

Concrete work:

- rename the internal function in [packages/procedure-engine/src/top-level-runner.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/procedure-engine/src/top-level-runner.ts:59) to `executeProcedure`; rename the file to `packages/procedure-engine/src/procedure-runner.ts`
- drop `ProcedureEngineAgentSession`, `ProcedureEngineAgentSessionPromptOptions`, and `ProcedureEngineAgentSessionPromptResult` from [packages/procedure-engine/src/index.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/procedure-engine/src/index.ts:119) and use `AgentSession`, `AgentSessionPromptOptions`, `AgentSessionPromptResult` from `@nanoboss/agent-acp` directly on the exported params type (export new names from `agent-acp` if they are not already public)
- drop `PreparedProcedurePrompt` from [packages/procedure-engine/src/index.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/procedure-engine/src/index.ts:114) and use the existing `PreparedDefaultPrompt` from `context/shared.ts` everywhere (they are structurally identical)
- drop `RunProcedureParams` / `ResumeProcedureParams` / `runProcedure` / `resumeProcedure` wrappers; export `executeProcedure` and its params type directly
- fold the `resume` branch into the single params type as an optional field, as it is today internally
- rename `TopLevelProcedureExecutionError` / `TopLevelProcedureCancelledError` to `ProcedureExecutionError` / `ProcedureCancelledError`; keep them as exported classes
- update [packages/app-runtime/src/service.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/app-runtime/src/service.ts:36) to call `executeProcedure({ ..., resume })` instead of the two wrappers
- update [packages/procedure-engine/src/dispatch/jobs.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/procedure-engine/src/dispatch/jobs.ts:21) to import the renamed symbol
- update engine tests that reference `TopLevelProcedureCancelledError` and the wrappers

Acceptance criteria:

- no `as` casts on `agentSession` or `timingTrace` in the engine's public entry
- `rg "\brunProcedure\b|\bresumeProcedure\b|\bexecuteTopLevelProcedure\b|ProcedureEngineAgentSession|TopLevelProcedure|PreparedProcedurePrompt" packages` returns zero matches
- workspace tests pass

Notes for the executing agent:

- keep `executeProcedure` behaviorally identical; this is a pure rename plus an interface alignment
- `AgentSession`, `AgentSessionPromptOptions`, and `AgentSessionPromptResult` may need to be exported from `@nanoboss/agent-acp/index.ts` if not already public; verify and add the re-exports as part of this item

### 3. Unify emitter types

[packages/procedure-engine/src/context/shared.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/procedure-engine/src/context/shared.ts:15) defines `SessionUpdateEmitter`. [packages/procedure-engine/src/index.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/procedure-engine/src/index.ts:107) defines `ProcedureEngineEmitter`, which is the same shape plus an optional `currentTokenUsage` field. [packages/procedure-engine/src/dispatch/progress.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/procedure-engine/src/dispatch/progress.ts:75) implements the narrow interface but also carries `currentTokenUsage`, straddling both.

Concrete work:

- merge into one interface in `context/shared.ts`:
  ```ts
  export interface SessionUpdateEmitter {
    emit(update: acp.SessionUpdate): void;
    emitUiEvent?(event: ProcedureUiEvent): void;
    flush(): Promise<void>;
    readonly currentTokenUsage?: AgentTokenUsage;
  }
  ```
- delete `ProcedureEngineEmitter` from [packages/procedure-engine/src/index.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/procedure-engine/src/index.ts:107)
- update `executeProcedure`'s params to take `SessionUpdateEmitter`
- update `ProcedureDispatchProgressEmitter` to declare the optional `currentTokenUsage` getter via the unified interface
- update every consumer in `app-runtime` and `adapters-*` to import the single name

Acceptance criteria:

- one `SessionUpdateEmitter` interface, re-exported from engine `index.ts`
- no `ProcedureEngineEmitter` symbol anywhere in the workspace
- dispatch progress path still carries token usage forward to the caller
- workspace tests pass

### 4. Extract `RuntimeBindings` and kill the clone-and-modify in child contexts

The triple `{ agentSession, getDefaultAgentConfig, setDefaultAgentSelection, prepareDefaultPrompt }` is threaded independently as `current*` and `root*` through `RunProcedureParams` → `executeProcedure` → `CommandContextImpl` → `createChildContext` → `ContextSessionApiImpl`. [packages/procedure-engine/src/context/context.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/procedure-engine/src/context/context.ts:178) `createChildContext` is a 10-field clone-and-modify that is almost guaranteed to drift when a new binding field is added.

Concrete work:

- introduce a single struct in `context/shared.ts`:
  ```ts
  export interface RuntimeBindings {
    agentSession?: AgentSession;
    getDefaultAgentConfig: () => DownstreamAgentConfig;
    setDefaultAgentSelection: (selection: DownstreamAgentSelection) => DownstreamAgentConfig;
    prepareDefaultPrompt?: (promptInput: PromptInput) => PreparedDefaultPrompt;
  }
  ```
- replace the eight `current*`/`root*` parameters in `CommandContextParams` with `current: RuntimeBindings; root: RuntimeBindings`
- replace the four top-level parameters in the `executeProcedure` params type with a single `bindings: RuntimeBindings` (root and current are identical at the top-level boundary)
- rewrite `createChildContext` to pass `{ current: childBindings, root: this.rootBindings }` rather than spreading ten fields
- update `ContextSessionApiImpl`'s constructor to take `{ current, root }` directly and keep its existing `resolveProcedureInvocationBinding` behavior
- this item depends on #2 (because the params type is being restructured at the same time) but is otherwise independent

Acceptance criteria:

- no duplicated `root*` / `*Value` private fields in `CommandContextImpl`
- `createChildContext` body mutates exactly one field (`current`) relative to the parent
- test suite covering nested procedure inheritance (e.g. `packages/procedure-engine/tests/context-api.test.ts`) passes unchanged
- `app-runtime/src/service.ts` builds `RuntimeBindings` once and passes it in

### 5. Single cancellation-normalisation helper

The pattern `normalizeRunCancelledError(err, softStopSignal?.aborted ? "soft_stop" : "abort")` appears at least four times: [packages/procedure-engine/src/context/agent-api.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/procedure-engine/src/context/agent-api.ts:197), [packages/procedure-engine/src/top-level-runner.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/procedure-engine/src/top-level-runner.ts:157), [packages/procedure-engine/src/dispatch/recovery.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/procedure-engine/src/dispatch/recovery.ts:29), and the `assertCanStartBoundary` paths in [packages/procedure-engine/src/context/context.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/procedure-engine/src/context/context.ts:207).

Concrete work:

- add a helper in `@nanoboss/procedure-sdk` (`packages/procedure-sdk/src/cancellation.ts`):
  ```ts
  export function toCancelledError(
    error: unknown,
    signals: { signal?: AbortSignal; softStopSignal?: AbortSignal },
  ): RunCancelledError | undefined;
  ```
  which picks `"soft_stop"` when `softStopSignal?.aborted` else `"abort"`, and delegates to `normalizeRunCancelledError`
- also add a companion `throwIfCancelled(signals)` for the pre-boundary checks in `assertCanStartBoundary` and `waitForRecoveredProcedureDispatchRun`
- replace every call site listed above with one of the two helpers
- keep `normalizeRunCancelledError` as the lower-level primitive; the new helpers are just the reason-resolving adapters

Acceptance criteria:

- `rg "normalizeRunCancelledError\s*\(\s*[^,)]+,\s*[^)]+\?\.aborted" packages` returns zero matches
- the four identified sites each reduce to a single helper call
- behavior (reason selection, error typing) is unchanged under tests

### 6. Narrow `ProcedureRegistryLike` in the SDK; centralise catalog behavior in `procedure-catalog`

Today [packages/procedure-sdk/src/index.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/procedure-sdk/src/index.ts:186) defines `ProcedureRegistryLike` with five methods:

```ts
export interface ProcedureRegistryLike {
  get(name: string): Procedure | undefined;
  register(procedure: Procedure): void;
  loadProcedureFromPath(path: string): Promise<Procedure>;
  persist(procedureName: string, source: string, cwd: string): Promise<string>;
  listMetadata(): ProcedureMetadata[];
}
```

`loadProcedureFromPath` and `persist` are never reached from any `Procedure` via `ProcedureApi` (procedures only see `ctx.procedures.run(name, prompt)`). Only catalog-authoring tooling (the `/create` builtin and CLI flows) calls them. Keeping them on the SDK interface overspecifies the contract and forces every embedding to stub disk-specific methods.

Concrete work:

- narrow SDK's `ProcedureRegistryLike` to:
  ```ts
  export interface ProcedureRegistryLike {
    get(name: string): Procedure | undefined;
    register(procedure: Procedure): void;
    listMetadata(): ProcedureMetadata[];
  }
  ```
- introduce a new `LoadableProcedureRegistry` interface in `@nanoboss/procedure-catalog` that extends the SDK shape with:
  ```ts
  export interface LoadableProcedureRegistry extends ProcedureRegistryLike {
    loadProcedureFromPath(path: string): Promise<Procedure>;
    persist(procedureName: string, source: string, cwd: string): Promise<string>;
  }
  ```
- update `ProcedureRegistry` in [packages/procedure-catalog/src/registry.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/procedure-catalog/src/registry.ts:32) to declare `implements LoadableProcedureRegistry`
- update engine code (engine only needs `ProcedureRegistryLike`); update catalog consumers (the `/create` procedure, any `app-runtime` code that calls `loadProcedureFromPath`/`persist`) to type against `LoadableProcedureRegistry`
- move the "no `resume`" guard from both `top-level-runner.resumeTopLevelProcedure` and `ProcedureRegistry.registerLoadableProcedure`'s wrapper into one shared helper in catalog (engine stays agnostic)
- leave the engine's import of `ProcedureRegistry` in [packages/procedure-engine/src/dispatch/jobs.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/procedure-engine/src/dispatch/jobs.ts:23) as-is; it is the sole "catalog-aware" site in the engine and is intrinsically coupled because the dispatch worker must rebuild a full loadable registry

Acceptance criteria:

- SDK's `ProcedureRegistryLike` has exactly three methods
- every call site that uses `loadProcedureFromPath` or `persist` types against `LoadableProcedureRegistry` from `@nanoboss/procedure-catalog`
- hermetic SDK consumer fixture (`packages/procedure-sdk/test-fixtures/consumer`) still typechecks, now against a smaller contract
- engine and catalog tests pass

### 7. Move reasoning-effort model parsing into `@nanoboss/agent-acp`

[packages/procedure-engine/src/agent-config.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/procedure-engine/src/agent-config.ts:1) currently encodes Copilot-specific `model@effort` behavior via `parseAgentModelSelection` and `toDownstreamAgentSelection`, wrapping `buildReasoningModelSelection` / `parseReasoningModelSelection` / `isReasoningEffort` from `@nanoboss/agent-acp`. The engine should be agnostic to provider-specific model syntax; agent-acp already owns model transport and provider defaults.

Concrete work:

- move `parseAgentModelSelection` and the `ParsedModelSelection` type into `@nanoboss/agent-acp` (co-locate with `buildReasoningModelSelection` / `parseReasoningModelSelection`)
- expose one `agent-acp` entry point that the engine calls with a `DownstreamAgentSelection` and gets back a fully-resolved `DownstreamAgentConfig`; the engine should not branch on `provider === "copilot"`
- move `baseAgentConfig(provider)` into `@nanoboss/agent-acp` as well; the engine should not know per-provider default commands and args
- keep `resolveDownstreamAgentConfig` as the engine's public adapter that mixes persisted selection + env override + cwd with whatever agent-acp returns; narrow it to a thin orchestration shim
- keep `toDownstreamAgentSelection` in the engine only if it is the engine's policy to render `model@effort` back on the selection for recording in `meta.defaultAgentSelection`; otherwise move it too
- update tests that assert reasoning-effort round-tripping to live where the logic lives (agent-acp) and remove the now-duplicate engine coverage

Acceptance criteria:

- engine contains no `provider === "copilot"` branch
- `rg "reasoningEffort|buildReasoningModelSelection|parseReasoningModelSelection" packages/procedure-engine` returns zero matches
- `resolveDownstreamAgentConfig` in the engine is under ~30 lines and does not switch on provider identity
- agent-acp tests cover the parsing/serialising symmetry that the engine previously covered
- all package tests pass

### 8. Split the engine public entrypoint; move test-only classes to `/testing`

Today `@nanoboss/procedure-engine`'s `index.ts` exports `CommandContextImpl` and `RunLogger` as part of the main public surface. Every non-test import of these symbols is absent: ripgrep confirms they are imported only from `packages/*/tests/**` (engine's own tests and one `app-runtime` test). Keeping them on the main entrypoint invites production code to reach into internals and makes it ambiguous which symbols are "runtime" vs "test harness."

Concrete work:

- add a second package export in [packages/procedure-engine/package.json](/Users/jflam/agentboss/workspaces/nanoboss/packages/procedure-engine/package.json:7):
  ```json
  "exports": {
    ".": "./src/index.ts",
    "./testing": "./src/testing.ts"
  }
  ```
- create `packages/procedure-engine/src/testing.ts` that re-exports `CommandContextImpl` (from `context/context.ts`) and `RunLogger` (from `logger.ts`)
- remove those two exports from `packages/procedure-engine/src/index.ts`
- update the two test files that import them:
  - [packages/procedure-engine/tests/context-ui.test.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/procedure-engine/tests/context-ui.test.ts:7)
  - [packages/procedure-engine/tests/context-api.test.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/procedure-engine/tests/context-api.test.ts:7)
  - [packages/app-runtime/tests/second-opinion-inherits-default-model.test.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/app-runtime/tests/second-opinion-inherits-default-model.test.ts:9)
  to import from `@nanoboss/procedure-engine/testing`
- leave `UiApiImpl` on the main entrypoint: it has a non-test consumer in [packages/app-runtime/src/runtime-events.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/app-runtime/src/runtime-events.ts:4)
- leave `ProcedureUiEvent` on the main entrypoint: it has a non-test consumer in [packages/adapters-tui/src/reducer.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/adapters-tui/src/reducer.ts:6)

Acceptance criteria:

- `rg "CommandContextImpl|\\bRunLogger\\b" packages --glob '!**/tests/**' --glob '!packages/procedure-engine/**'` returns zero matches
- `rg "from \"@nanoboss/procedure-engine\"" packages --glob '**/tests/**'` imports of `CommandContextImpl` / `RunLogger` all go through `@nanoboss/procedure-engine/testing`
- `bun test` passes across the workspace

## Order of operations

The items are independently shippable but have a recommended sequence because 1, 2, 4, and 8 structurally change the engine's public surface:

1. Land item **1** first. It strips alternate import paths and makes every subsequent edit unambiguous.
2. Land items **2** and **4** together. They both reshape `executeProcedure`'s params type, so doing them separately would churn the same API twice.
3. Land item **3**. Small, contained.
4. Land item **5**. Small, contained.
5. Land item **8**. Independent of 1–5 but cleaner to land after the main entrypoint is otherwise stable.
6. Land item **6**. Touches SDK surface; do it after the engine is stable.
7. Land item **7**. Touches agent-acp surface; independent from 1–6 and 8.

Each item should land as its own commit. Each commit must pass `bun test` and `bun run typecheck` at repo root and in every affected package.

## Validation

For each item:

- run `bun test` at the repo root
- run `bun run typecheck` at the repo root
- for items that touch `procedure-sdk`, additionally run `cd packages/procedure-sdk && bun run test:hermetic` to make sure the built-artifact consumer fixture still compiles
- for items that touch `procedure-engine`, additionally run `cd packages/procedure-engine && bun test`
- for item **7**, additionally run `cd packages/agent-acp && bun test`

Once all eight items are landed, the grep acceptance checks in each section should all be zero-match.

## Follow-ups (intentionally out of scope)

These are genuine improvements surfaced during analysis but not part of this plan:

- **Unify nested and top-level procedure invocation.** Today `ProcedureInvocationApiImpl.run` constructs a child `CommandContextImpl` directly; it does not go through `executeProcedure`. A future cleanup could fold nested invocation into `executeProcedure` with a `{ parent: ProcedureBoundary } | { topLevel: true }` discriminator. Deferred because it changes the call graph and deserves its own design.
- **Move `procedure-catalog/src/builtins.ts` into `app-runtime`.** The hard-coded list of app-specific procedures makes `procedure-catalog` not-truly-generic. A future change can hoist the builtin list into the app composition layer and let the catalog package become a pure loader.
- **Shared "procedure does not support resume" guard.** After #2 and #6 land, the two guards in the runner and the catalog wrapper are adjacent; consolidating them into one helper in `procedure-catalog` is a natural follow-up.

## References

- Factoring analysis summary: 2026-04-18 conversation with the user ("study the packages/procedure-engine and packages/procedure-sdk…").
- Existing package hermetic plan: [plans/2026-04-17-procedure-sdk-hermetic-package-plan.md](/Users/jflam/agentboss/workspaces/nanoboss/plans/2026-04-17-procedure-sdk-hermetic-package-plan.md).
- Package isolation plan: [plans/2026-04-16-package-isolation-plan.md](/Users/jflam/agentboss/workspaces/nanoboss/plans/2026-04-16-package-isolation-plan.md).
