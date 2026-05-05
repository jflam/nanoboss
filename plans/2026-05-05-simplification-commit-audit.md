# Simplification Commit Audit: `15ae394^..HEAD`

Date: 2026-05-05

Branch created for this work: `audit/15ae394-to-head-20260505`

Range audited: `15ae3948e88aa4775e21ec0138a4c89331b6d89b` (`Document app-runtime ownership`) through `5ea81c417ea4b744f5068c78286b18fcb46f97c7` (`Guard TUI helper convergence`), inclusive.

This report treats the range as the bucket requested by the user: every commit from the current tip back through `15ae394`. In git range terms that is `15ae394^..HEAD`, which contains 198 commits.

## Executive Verdict

This range is directionally good and substantially improves package-boundary clarity, but it is not finished simplification work.

The strongest work is at the public API and ownership level. The commits document package boundaries, replace wildcard-style public surfaces with explicit package entrypoints, remove or internalize accidental helper exports, add tests that guard canonical helper ownership, and move several large implementation files toward named responsibilities. That directly supports the goal of having one obvious way to do common things.

The main risk is that much of the work is decomposition by extraction. The range moves code out of large files, but it also increases the total number of source files and total TypeScript lines. In the TUI adapter especially, future agents now face a broad flat field of many small `app-*`, `controller-*`, `reducer-*`, `views-*`, `run-*`, `core-*`, and `theme-*` modules. That is easier to read locally than 1,400-line files, but it is not automatically easier to understand globally. Without layer rules and directory ownership, agents can still create multiple paths for similar behavior.

I would keep the branch, but I would not call this simplification campaign complete. It should be followed by a convergence pass whose default move is consolidation, not more splitting.

## What Was Done

The 198 commits fall into a coherent sequence.

First, package ownership was documented. The range adds or updates boundary docs for app-runtime, app-support, procedure-catalog, TUI extension catalog, ACP server adapter, HTTP adapter, MCP adapter, contracts, TUI extension SDK, TUI adapter, procedure-engine, store, and related packages. These docs explain what each package owns, what it does not own, and which neighboring package owns adjacent behavior.

Second, public package surfaces were tightened. Package barrels now avoid wildcard exports and expose explicit symbols. Tests in `tests/unit/public-package-entrypoints.test.ts` guard deleted root shims, canonical package imports, explicit entrypoints, package manifest parity, and known helper ownership. This is one of the highest-value parts of the range because it reduces the number of places an agent can accidentally import from or extend.

Third, accidental helper seams were removed or internalized. The range internalizes token metric parsing, app-runtime helper seams, HTTP SSE parsing, agent model selection helpers, store timestamp formatting, TUI view and command helpers, form renderer registry helpers, agent response parsers, MCP registration helpers, runtime event guards, runtime prompt memory helpers, runtime dispatch result parsing/guards, runtime event logs, and more. It also removes stale knip ignores, unused HTTP/runtime event guard aliases, procedure-engine compatibility re-exports, obsolete default dispatch paths, and unused model catalog wrappers.

Fourth, large files were split into smaller implementation modules. The largest reductions are real:

- `packages/adapters-tui/src/reducer.ts`: 1,418 lines to 15
- `packages/app-runtime/src/service.ts`: 1,479 lines to 588
- `packages/adapters-tui/src/app.ts`: 875 lines to 276
- `packages/adapters-tui/src/controller.ts`: 789 lines to 315
- `packages/adapters-mcp/src/server.ts`: 669 lines to 65
- `packages/procedure-engine/src/context/agent-api.ts`: 617 lines to 180
- `packages/adapters-tui/src/views.ts`: 539 lines to 118
- `packages/store/src/session-store.ts`: 978 lines to 510

Those extractions are not just cosmetic. The inspected files show genuine ownership separations:

- MCP now has `tool-definitions.ts`, `tool-args.ts`, `tool-result-format.ts`, and stdio framing instead of one server module owning protocol, tool catalog, argument parsing, and output formatting.
- Store now separates persisted run record shaping, prompt image attachment persistence, and ref/value materialization from `SessionStore`.
- Procedure-engine separates agent child-run recording, named ref resolution, output event shaping, bound agent invocation, dispatch job storage, wait policy, worker command wiring, and cancellation watching.
- App-runtime separates prompt run lifecycle/finalization, runtime command publication, continuation cancellation, run publication, tool event mapping, and runtime service APIs from the foreground service.
- TUI separates reducer transitions, controller flows, app wiring, extension boot, theme pieces, chrome, transcript views, tool cards, runner lifecycle, and state record contracts.

## Range Metrics

Commits by leading subject word:

- `Split`: 148
- `Internalize`: 19
- `Document`: 10
- `Remove`: 8
- `Consolidate`: 5
- `Guard`: 3
- `Centralize`: 1
- `Correct`: 1
- `Move`: 1
- `Prune`: 1
- `Refine`: 1

Overall diffstat:

- 294 files changed
- 15,268 insertions
- 10,637 deletions

Package source shape:

- Package `src` TypeScript files increased from 161 to 311.
- Package `src` TypeScript lines increased from 27,762 to 30,071.
- `packages/adapters-tui/src` source files increased from 47 to 156.
- 119 of the 198 commits touched `packages/adapters-tui/src`.

Changed package source files by package:

- `adapters-tui`: 136
- `procedure-engine`: 20
- `app-runtime`: 18
- `agent-acp`: 13
- `adapters-mcp`: 8
- `app-support`: 7
- `adapters-http`: 7
- `store`: 6
- `adapters-acp-server`: 4
- `tui-extension-catalog`: 2
- `procedure-catalog`: 1

These numbers matter. The codebase is better factored in important places, but it is also larger and has more modules. That tradeoff is acceptable only if the new modules become durable concepts with clear ownership and guarded import paths.

## Static Analysis and Tooling

Existing tooling:

- `bun run knip` completed successfully. It reported no production unused exports/files with the current `knip --production --reporter compact` configuration.
- `git diff --check 15ae394^..HEAD` completed successfully.

Duplicate-code scan:

- A broad `jscpd` scan over `packages src procedures tests` did not complete in a useful time window and was stopped.
- A focused `jscpd` scan over `packages/adapters-tui/src` completed successfully.
- TUI duplicate result: 153 files analyzed, 10,189 lines, 2 clone groups, 27 duplicated lines, 307 duplicated tokens, 0.26% duplicated lines.

The two TUI clone groups were:

- `views-tool-transcript.ts` and `views-turns.ts`: both implement the same small component lifecycle skeleton around a `Container`, `render`, `invalidate`, and `rebuild`.
- `reducer-tool-event-records.ts`: `buildStartedToolCall` and `buildUpdatedToolCall` duplicate common parent/transcript/remove/tool-name object assembly.

Import-cycle scan:

- `madge packages/adapters-tui/src --extensions ts --circular` found 9 circular dependencies.
- `madge packages/app-runtime/src packages/procedure-engine/src packages/store/src packages/agent-acp/src --extensions ts --circular` found 5 circular dependencies.

TUI cycles:

- `activity-bar-cascade.ts > activity-bar.ts`
- `state.ts > state-initial.ts`
- `app-types.ts > app-model-selection.ts`
- `clipboard/provider.ts > clipboard/darwin.ts`
- `clipboard/provider.ts > clipboard/linux.ts`
- `clipboard/provider.ts > clipboard/unsupported.ts`
- `clipboard/provider.ts > clipboard/win32.ts`
- `controller-types.ts > controller-session.ts`
- `controller-types.ts > controller-stream.ts`

Runtime/engine/store/agent cycles:

- `app-runtime/src/runtime-events.ts > app-runtime/src/runtime-tool-events.ts`
- `app-runtime/src/session-runtime.ts > app-runtime/src/default-agent-policy.ts`
- `procedure-engine/src/dispatch/cancellation-watcher.ts > procedure-engine/src/dispatch/job-store.ts > procedure-engine/src/dispatch/jobs.ts`
- `procedure-engine/src/dispatch/job-store.ts > procedure-engine/src/dispatch/jobs.ts`
- `procedure-engine/src/dispatch/jobs.ts > procedure-engine/src/dispatch/status.ts`

These cycles are not necessarily runtime bugs, but they are exactly the sort of shape that makes future refactors harder. They also weaken the "single path" goal because cyclic modules often become informal bidirectional APIs.

## What Looks Good

The public API cleanup is the best simplification in the range. Explicit package entrypoints and tests that reject wildcard barrels are concrete protections against accidental surface growth.

The helper-owner tests are valuable. `tests/unit/package-helper-ownership.test.ts` now encodes canonical owners for data-shape helpers, text summarization, error formatting, tool payload normalization, self-command resolution, and timing traces. `tests/unit/public-package-entrypoints.test.ts` also guards many package-level import and export rules. This is the right kind of complexity reduction because it makes duplicate helper reintroduction fail fast.

The TUI-specific convergence guard is also valuable. `tests/unit/tui-helper-convergence.test.ts` keeps banned glue files such as `app-inline-select.ts`, `app-model-prompts.ts`, and `core-panel-fallbacks.ts` from coming back, while asserting canonical owners for inline select, model prompts, and system panel fallback rendering. That is exactly aligned with "do not have more than one way to do anything."

The app-runtime and MCP extractions are clearer after inspection. `NanobossService` is still large, but the extracted modules now make foreground run lifecycle, run publication, prompt finalization, runtime commands, and tool event mapping easier to locate. MCP's `server.ts` is now a small protocol entrypoint, and the tool catalog is centralized in one array of `defineTool(...)` calls with argument parsing delegated to `tool-args.ts`.

The store split is mostly good. `SessionStore` still owns live store operations, while `session-records.ts` owns record/result/summary shaping and `stored-value-access.ts` owns ref path materialization. That is a real reduction in mixed concerns.

Several fallbacks are explicitly justified and should stay for now:

- TUI procedure-panel replay fallback in `views-procedure-panels.ts`, because persisted transcript replay can reference renderers that are no longer registered.
- Store legacy session metadata parsing in `session-repository.ts`, because older persisted sessions still exist.
- Agent catalog discovery fallback cache, because a failed refresh should not erase a known-good catalog.
- Runtime current-session fallback, because MCP-style tools can be launched in a workspace where the current session is implicit.

These are not duplicate paths in the bad sense. They are compatibility or resilience paths. The important thing is that they remain classified and tested.

## Critical Findings

### 1. `getNanobossHome` has three implementations

`getNanobossHome` exists in:

- `packages/app-support/src/nanoboss-home.ts`
- `packages/agent-acp/src/config.ts`
- `packages/store/src/paths.ts`

All three currently compute the same path:

```ts
join(process.env.HOME?.trim() || homedir(), ".nanoboss")
```

This violates the one-way rule. It is simple today, but it is a future bug source because any change to home directory policy, test isolation, or platform behavior must be duplicated exactly. The canonical owner should be `@nanoboss/app-support`; `agent-acp` and `store` should import it unless doing so creates a package layering problem. If there is a layering reason not to import it, that reason should be documented and guarded by a test.

### 2. Cancellation error ownership is duplicated between `agent-acp` and `procedure-sdk`

`packages/agent-acp/src/cancellation.ts` defines `RunCancellationReason`, `RunCancelledError`, and `defaultCancellationMessage`. `packages/procedure-sdk/src/cancellation.ts` defines the same core concepts plus normalization helpers. Agent ACP code imports the local version, while app-runtime/procedure-engine code imports the SDK version.

That means there are at least two cancellation error classes with the same name and message policy. The SDK normalization code has to compensate for this by accepting error-name compatibility. That is a smell. It works, but it codifies the duplicate path instead of removing it.

Recommendation: make `@nanoboss/procedure-sdk` the single cancellation owner. `agent-acp` should use the SDK class directly unless a hard dependency boundary forbids it. If the boundary forbids it, rename the local class so it is not pretending to be the same type.

### 3. Procedure UI marker parsing exists in two packages

`packages/procedure-engine/src/ui-events.ts` owns `PROCEDURE_UI_MARKER_PREFIX`, marker rendering, typed parsing, tagged stream construction, and fallback text formatting. `packages/agent-acp/src/ui-marker.ts` has its own prefix constant and a weaker `parseProcedureUiMarker(text): unknown | undefined`.

This is another real duplicate path. The agent package only needs to suppress internal UI marker text from user-visible assistant text; it does not own the marker contract. The current weaker parser can diverge from the engine parser and still compile.

Recommendation: expose a minimal marker detector/parser from the canonical owner or move the marker prefix and untyped detector to a lower shared package. There should be exactly one marker prefix constant.

### 4. TUI has low textual duplication but high architectural surface area

The focused `jscpd` result is low, which is good. The problem is not copy-paste volume. The problem is navigation and layer shape.

`packages/adapters-tui/src` now has 156 source files, with 130 TypeScript files directly in the top-level `src` directory. The package docs need a long inventory to explain the internal shape. That inventory is useful, but its length is also evidence that the package needs grouping.

The flat prefix convention is doing too much work:

- `app-*`
- `controller-*`
- `reducer-*`
- `views-*`
- `run-*`
- `core-*`
- `theme-*`

Prefixes are weaker than directories and import rules. They help names sort together, but they do not stop an agent from importing controller internals into views or state internals into app wiring.

Recommendation: group TUI files into owner directories and add an architecture test for allowed imports. The next pass should move files into directories such as `app/`, `controller/`, `reducer/`, `views/`, `run/`, `theme/`, `core/`, `extensions/`, `components/`, `overlays/`, and `clipboard/`, with explicit index files only where they simplify imports.

### 5. New circular dependencies should be treated as blockers for further splitting

The cycle scan found 14 cycles across TUI, app-runtime, procedure-engine, store, and agent-acp. Several are likely easy type/value ownership problems:

- `state.ts > state-initial.ts`
- `app-types.ts > app-model-selection.ts`
- `controller-types.ts > controller-session.ts`
- `controller-types.ts > controller-stream.ts`
- `runtime-events.ts > runtime-tool-events.ts`
- `session-runtime.ts > default-agent-policy.ts`

The dispatch cycles are more concerning because they suggest job orchestration, persistence, status shaping, and cancellation are still interdependent:

- `cancellation-watcher.ts > job-store.ts > jobs.ts`
- `job-store.ts > jobs.ts`
- `jobs.ts > status.ts`

Recommendation: add a `madge` circular dependency check to pre-commit or a targeted architecture test once the existing cycles are fixed. Do not add the check before fixing the baseline, or it will become another ignored warning.

### 6. Some split files are only wiring bundles

Several modules are durable concepts: `tool-definitions.ts`, `tool-args.ts`, `session-records.ts`, `stored-value-access.ts`, `prompt-image-attachments.ts`, `agent-run-recorder.ts`, `runtime-tool-events.ts`, and `run-publication.ts`.

Some modules are thinner wiring bundles: `app-runtime-wiring.ts`, `app-controller-wiring.ts`, `app-runtime-helpers.ts`, `controller-initial-state.ts`, `run-tty.ts`, and `dispatch/wait.ts`. Thin modules are not inherently bad, but too many of them make the codebase feel like a routing table. The test should be whether each file has a stable reason to change. If the reason is "because a large file needed to be smaller", the file may need to be folded into a more durable owner after the extraction settles.

### 7. TUI component lifecycle skeletons are duplicated

`views-tool-transcript.ts` and `views-turns.ts` share the same component lifecycle pattern:

- own a `Container`
- rebuild on state change
- delegate `render`
- invalidate then rebuild
- append a trailing spacer

This is small, but it is a clean candidate for a tiny local helper or base factory if more transcript entry components follow the same pattern. Do not introduce an abstraction for only these two files unless a third similar component appears or the current duplication starts hiding real behavior differences.

### 8. Tool-call record assembly has near-duplicate object construction

`buildStartedToolCall` and `buildUpdatedToolCall` in `reducer-tool-event-records.ts` duplicate parent/transcript/remove/tool-name assembly and much of the returned `UiToolCall` object structure.

This one is more worth fixing than the transcript component clone because tool-call event handling is bug-prone. A shared `buildToolCallBase(...)` helper could make the defaulting rules explicit:

- parent id resolution
- transcript visibility default
- remove-on-terminal default
- tool name retention
- depth retention
- wrapper classification

The goal should be fewer paths for tool-call state defaults, not just fewer lines.

## Recommendations

### Priority 1: Remove semantic duplicate owners

Make one owner for each of these:

- Nanoboss home directory resolution
- cancellation error/message policy
- procedure UI marker prefix/parsing
- tool preview block contract
- TUI duration formatting

The first three are the highest risk. They are not large, but they are policy-level helpers, and policy helpers are exactly where silent divergence creates bugs.

### Priority 2: Fix import cycles before more extraction

Use the `madge` findings as the next cleanup checklist. Start with type/value cycles where the owner is obvious:

- Move pure types out of modules that also construct values.
- Keep `*-types.ts` files free of imports from behavior modules.
- Make dispatch status/store/cancellation helpers depend inward on shared types, not back on `jobs.ts`.
- Keep runtime event type definitions independent from event mappers when possible.

After the baseline is clean, add a pre-commit guard for cycles.

### Priority 3: Turn the TUI prefix field into directories with layer rules

The TUI package is now the main complexity sink. Do not keep adding top-level prefixed files. Move related files into directories and add a test that encodes import rules.

Suggested rules:

- `app` can depend on controller, views, run helpers, theme, and core registries.
- `controller` can depend on reducer actions and HTTP client/session abstractions.
- `reducer` can depend on state contracts and pure formatting helpers, but not app/controller/view modules.
- `views` can depend on state contracts, theme, and component helpers, but not controller/app.
- `run` can depend on app and adapter startup, but app internals should not depend on run.
- `core` can register built-in bindings/chrome/panels, but should not own app lifecycle.

This will make it easier for future agents to decide where new code belongs.

### Priority 4: Classify every fallback path

The current fallback/legacy paths are not all bad. Some are required. The next report or cleanup pass should classify each as:

- persisted-data compatibility
- user-facing resilience
- tool-server convenience
- removable entropy

Then add a short owner comment or test for the first three categories and delete the fourth. This keeps "fallback" from becoming a vague license to add alternate behavior.

### Priority 5: Prefer consolidation over further splitting

The range already split aggressively. The next pass should ask:

- Does this helper file encode a durable domain concept?
- Is there exactly one caller?
- Is the name obvious to someone who did not write the split?
- Does the file prevent duplicate policy, or just move lines around?
- Would a directory-level owner make it easier to find than another top-level prefix file?

If the answer is weak, fold the helper into the nearest durable owner.

## Suggested Follow-Up Work Items

1. Replace duplicate `getNanobossHome` implementations with a single canonical implementation or document and guard why multiple package-local implementations must exist.
2. Collapse `agent-acp` cancellation classes/messages onto `procedure-sdk` cancellation, or rename the local concept so there are not two identically named error classes.
3. Unify procedure UI marker prefix/parsing under one owner.
4. Fix the 14 circular dependencies reported by `madge`.
5. Add a targeted architecture test for TUI import layers after cycles are removed.
6. Move TUI top-level prefixed files into owner directories.
7. Consolidate tool-call event record defaulting in `reducer-tool-event-records.ts`.
8. Decide whether transcript entry lifecycle duplication should stay local or become a tiny helper after the next similar component appears.
9. Classify fallback/legacy paths and write tests/comments for the ones that intentionally remain.
10. Keep `knip`, explicit-entrypoint tests, helper-owner tests, and TUI helper convergence tests as permanent gates.

## Bottom Line

The branch is valuable. It makes package boundaries clearer, removes accidental public seams, and creates guardrails against several duplicate-helper families. That is real simplification.

The branch also increases implementation surface area. The TUI adapter now has many more modules, and cycle analysis shows some extracted modules still depend on each other bidirectionally. The next engineering move should be convergence: one owner per policy helper, no import cycles, directory-level TUI ownership, and fewer thin wiring files.

The standard for accepting future simplification work should be: fewer ways to do the same thing, fewer cross-layer imports, fewer cycles, and clearer owner tests. Raw file-size reduction alone is not enough.
