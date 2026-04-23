# Cross-package duplicate helper sweep plan

## Purpose

Review and simplify duplicate helper families that survived package extraction.
This is the second package review target from
`plans/2026-04-23-package-review-roadmap.md`, after the TUI extension stack.

The desired outcome is one owner per helper behavior, with package imports
following that ownership and tests preventing duplicate implementations from
reappearing.

## Current state

### Duplicate helper families

Known duplicate or near-duplicate implementations:

| Helper family | Current locations | Owner hypothesis |
| --- | --- | --- |
| `inferDataShape` / `stringifyCompactShape` | `packages/store/src/data-shape.ts`, `packages/procedure-engine/src/data-shape.ts`, embedded copy in `packages/app-runtime/src/memory-cards.ts` | Move to the lowest package that can represent procedure result shapes without runtime policy, likely `@nanoboss/procedure-sdk` unless Phase 1 proves this is store-owned persistence metadata. |
| `summarizeText` | `packages/procedure-sdk/src/text.ts`, `packages/store/src/text.ts`, `packages/agent-acp/src/text.ts` | Keep `@nanoboss/procedure-sdk` as canonical owner and import it from store and agent-acp. |
| `formatErrorMessage` | `packages/procedure-sdk/src/error-format.ts`, `packages/store/src/error-format.ts` | Keep `@nanoboss/procedure-sdk` as canonical owner and import it from store. |
| `normalizeToolInputPayload` / `normalizeToolResultPayload` | `packages/app-runtime/src/tool-payload-normalizer.ts`, `packages/adapters-tui/src/tool-payload-normalizer.ts` | Pick a non-UI owner for adapter-neutral tool payload normalization, then keep TUI card formatting local to `@nanoboss/adapters-tui`. |
| `resolveSelfCommand` | `packages/procedure-engine/src/self-command.ts`, `packages/adapters-http/src/self-command.ts`, `packages/adapters-mcp/src/self-command.ts`, local variant in `packages/agent-acp/src/runtime-capability.ts` | Centralize command resolution in the lowest package that legitimately owns process entrypoint discovery, likely `@nanoboss/app-support` unless Phase 1 proves it should remain procedure-engine-owned. |

### Existing guardrails

`tests/unit/procedure-engine-helper-convergence.test.ts` already prevents some
old root and procedure-engine helper copies from returning. It does not yet
cover all duplicate helper families listed above, and it does not enforce a
single owner for tool payload normalization, data shape inference, or
self-command resolution across adapter packages.

## Desired package boundaries

### Canonical helper owners

Canonical owners should be selected by dependency direction:

- Prefer `@nanoboss/procedure-sdk` for pure procedure/result contracts that have
  no runtime, persistence, or adapter policy.
- Prefer `@nanoboss/app-support` only for low-level process, filesystem, or
  workspace support primitives that are not procedure-specific.
- Prefer `@nanoboss/store` only for persistence-specific metadata behavior.
- Do not use `@nanoboss/app-runtime` as a general helper owner; keep it focused
  on orchestration and policy.
- Do not use adapters as helper owners unless the helper is protocol-specific
  presentation or translation.

### Consumers

Consumers should import public package APIs instead of copying implementation
files. If a helper is intentionally not shared, the reason must be documented
and guarded by a test so a future duplicate with the same name is not mistaken
for drift.

## Proposed review phases

### Phase 1: inventory behavior and choose owners

Actions:

- For each helper family, list every implementation, public export, package
  dependency, and repo consumer.
- Compare behavior, not just names. Capture exact differences such as
  `formatErrorMessage` fallback behavior and `inferDataShape` truncation marker
  differences.
- Decide the canonical owner for each family and document the dependency graph
  impact before editing imports.
- Identify any public exports that need a temporary re-export for compatibility.

Acceptance:

- Produce an owner decision table with consumer evidence and a concrete import
  migration path for all five helper families.
- Confirm the proposed owners keep
  `tests/unit/package-dependency-direction.test.ts` acyclic.

Phase 1 output:

Current package dependency inventory for implementation packages:

- `@nanoboss/procedure-sdk` currently depends on `@nanoboss/contracts`.
- `@nanoboss/store` currently depends on `@nanoboss/app-support`,
  `@nanoboss/contracts`, and `@nanoboss/procedure-sdk`.
- `@nanoboss/agent-acp` currently depends on `@nanoboss/contracts`,
  `@nanoboss/procedure-sdk`, and `@nanoboss/store`.
- `@nanoboss/procedure-engine` currently depends on `@nanoboss/agent-acp`,
  `@nanoboss/contracts`, `@nanoboss/procedure-catalog`,
  `@nanoboss/procedure-sdk`, and `@nanoboss/store`.
- `@nanoboss/app-runtime` currently depends on `@nanoboss/agent-acp`,
  `@nanoboss/app-support`, `@nanoboss/contracts`,
  `@nanoboss/procedure-catalog`, `@nanoboss/procedure-engine`,
  `@nanoboss/procedure-sdk`, and `@nanoboss/store`.
- `@nanoboss/adapters-tui` currently depends on `@nanoboss/adapters-http`,
  `@nanoboss/agent-acp`, `@nanoboss/app-support`, `@nanoboss/contracts`,
  `@nanoboss/procedure-engine`, `@nanoboss/procedure-sdk`,
  `@nanoboss/store`, `@nanoboss/tui-extension-catalog`, and
  `@nanoboss/tui-extension-sdk`.
- `@nanoboss/adapters-http` currently depends on `@nanoboss/agent-acp`,
  `@nanoboss/app-support`, `@nanoboss/app-runtime`, and
  `@nanoboss/procedure-sdk`.
- `@nanoboss/adapters-mcp` currently depends on `@nanoboss/app-support`,
  `@nanoboss/app-runtime`, `@nanoboss/contracts`,
  `@nanoboss/procedure-sdk`, and `@nanoboss/store`.
- `@nanoboss/app-support` has no workspace package dependencies.

| Helper family | Implementations and public exports | Current consumers | Behavior differences | Chosen owner and migration path | Compatibility re-exports | Dependency impact |
| --- | --- | --- | --- | --- | --- | --- |
| Data shape helpers: `inferDataShape`, `stringifyCompactShape` | `packages/store/src/data-shape.ts` exports `inferDataShape` from a private file; `@nanoboss/store` does not barrel-export it. `packages/procedure-engine/src/data-shape.ts` exports both helpers and `packages/procedure-engine/src/index.ts` publicly exports both. `packages/app-runtime/src/memory-cards.ts` embeds private copies of both helpers. | Store uses `inferDataShape` in `packages/store/src/session-store.ts` for persisted run summaries and records. Procedure engine uses `inferDataShape` in `packages/procedure-engine/src/dispatch/recovery.ts` and `packages/procedure-engine/src/run-result.ts`; `packages/app-runtime/src/runtime-service.ts` imports it from `@nanoboss/procedure-engine`. App runtime memory cards use the embedded helpers in `packages/app-runtime/src/memory-cards.ts`. Procedure-engine package tests import the public data-shape surface indirectly through the package barrel. | Store and procedure-engine `inferDataShape` are identical: max depth 4, object keys 12, array items 3, literal strings up to 24 chars, `RunRef` for run/cell refs, `Ref` for ref/value refs, depth overflow `["..."]` or `{ "...": "..." }`, object overflow key `"..."`. Procedure-engine alone has `stringifyCompactShape`, returning `undefined` for `undefined` and truncating JSON with ASCII `...`. App-runtime uses the same shape rules except its depth and object overflow marker is Unicode `…`; its `stringifyCompactShape` truncation suffix is still ASCII `...`. | Move both helpers to `@nanoboss/procedure-sdk` because shape inference describes procedure result metadata, depends only on `@nanoboss/contracts` types that the SDK already owns, and is not persistence-specific runtime policy. Export them from `packages/procedure-sdk/src/index.ts`. Update store, procedure-engine recovery/run-result, app-runtime memory cards, and app-runtime runtime-service imports to use `@nanoboss/procedure-sdk`. Normalize app-runtime to the canonical ASCII overflow marker unless Phase 2 decides to preserve Unicode with a compatibility test. | Keep a temporary `@nanoboss/procedure-engine` public re-export for `inferDataShape` and `stringifyCompactShape` because they are currently in its public barrel and `packages/app-runtime/src/runtime-service.ts` consumes that public API today. Store and app-runtime have no public data-shape export to preserve. | No new package edges for store, procedure-engine, or app-runtime because all already depend on `@nanoboss/procedure-sdk`. The owner remains below all consumers and adds no cycle. |
| `summarizeText` | `packages/procedure-sdk/src/text.ts`, `packages/store/src/text.ts`, and `packages/agent-acp/src/text.ts` each export an identical function from local files. Only `packages/procedure-sdk/src/index.ts` publicly barrel-exports it. Store and agent-acp do not expose their local copies through package barrels. | Store uses the local copy in `packages/store/src/session-store.ts` and `packages/store/src/session-picker-format.ts`. Agent ACP uses the local copy in `packages/agent-acp/src/updates.ts`. Existing SDK consumers include procedure-engine, app-runtime tool-call previews, app-runtime memory cards, procedure-sdk tests, and package smoke tests. | All three implementations are byte-for-byte identical. They collapse whitespace to a single space, trim, return `""` for empty compact text, and truncate with `compact.slice(0, maxLength - 3).trimEnd() + "..."`. Default max length is 80. | Keep `@nanoboss/procedure-sdk` as canonical. Update store and agent-acp imports to `@nanoboss/procedure-sdk`, then delete the local files if no other private imports remain. | No compatibility re-export needed; only the SDK copy is public. | No new package edges because store and agent-acp already depend on `@nanoboss/procedure-sdk`. Acyclic direction is unchanged. |
| `formatErrorMessage` | `packages/procedure-sdk/src/error-format.ts` and `packages/store/src/error-format.ts` each export a local function. Only `packages/procedure-sdk/src/index.ts` publicly barrel-exports it. Store does not expose its local copy. | Store uses the local copy in `packages/store/src/settings.ts`, `packages/store/src/session-repository.ts`, and `packages/store/src/session-cleanup.ts`. SDK consumers include procedure-engine runner/context code, app-runtime service code, procedure-engine tests, and procedure-sdk result-contract tests. | Both prefer non-empty `Error.message`, then strings, then object `.message`, then `JSON.stringify`, then a fallback. The exact difference is the object serialization failure fallback: SDK returns `Object.prototype.toString.call(error)`, while store falls through to `String(error)`. SDK is safer for exotic or cyclic values whose custom `toString` can throw or recurse; ordinary objects still produce `"[object Object]"` in both. | Keep `@nanoboss/procedure-sdk` as canonical. Update store imports to `@nanoboss/procedure-sdk`, preserve SDK fallback behavior, and delete the store-local file once imports are migrated. | No compatibility re-export needed; only the SDK copy is public. | No new package edge because store already depends on `@nanoboss/procedure-sdk`. Acyclic direction is unchanged. |
| Tool payload normalization: `normalizeToolInputPayload`, `normalizeToolResultPayload`, plus helper extraction functions | `packages/app-runtime/src/tool-payload-normalizer.ts` exports `ToolPayloadIdentity`, `normalizeToolName`, both normalizers, `extractToolErrorText`, `extractPathLike`, `asRecord`, `firstString`, and `firstNumber` from a private module; `@nanoboss/app-runtime` does not barrel-export it. `packages/adapters-tui/src/tool-payload-normalizer.ts` imports the `ToolPayloadIdentity` type from `./tool-preview.ts` and exports both normalizers plus `extractToolErrorText`, `asRecord`, `firstString`, `stringifyValue`, and `extractPathLike`; `@nanoboss/adapters-tui` does not barrel-export it. | App runtime uses its copy only from `packages/app-runtime/src/tool-call-preview.ts`. TUI uses its copy from `packages/adapters-tui/src/components/tool-card-format.ts`. | The normalizer behavior is equivalent: lower-case tool identity from explicit tool name, non-generic kind, or title; map `mock ...` to the second token and `callAgent`, `defaultSession:`, or `calling ...` to `agent`; produce command/read/write/edit/grep/find/ls headers; extract path-like fields from direct, location, first location, file, or target records; extract text from common direct and nested fields; extract list-like lines from matches/items/entries/files/paths/results/lines; stringify fallback JSON with a 200000-character limit and `\n…`. Differences are export shape and type ownership only: app-runtime owns and exports `ToolPayloadIdentity`, `normalizeToolName`, and `firstNumber`; TUI imports identity from its preview type, keeps `normalizeToolName` and `firstNumber` private, and exports `stringifyValue` for expanded-card rendering. Adapter-specific presentation remains outside the normalizer: app-runtime applies ANSI stripping, preview bounds, warning extraction, truncation flags, and header/body summaries in `tool-call-preview.ts`; TUI applies colors, diff/code highlighting, collapsed-line messages, and expansion behavior in `tool-card-format.ts`. | Move adapter-neutral normalization to `@nanoboss/procedure-sdk` as a pure data helper because both consumers already depend on it and `@nanoboss/app-support` should not become a general utility bucket. Export `ToolPayloadIdentity`, the normalized payload type, both normalizers, `normalizeToolName`, `extractToolErrorText`, `extractPathLike`, `asRecord`, `firstString`, `firstNumber`, and `stringifyValue` from the SDK. Update app-runtime and TUI imports to the SDK, while keeping preview truncation and TUI card formatting local. | No public compatibility re-export needed because neither app-runtime nor adapters-tui exposes its normalizer through its package entrypoint. A private shim can be used during Phase 3 only if it keeps the diff smaller, but it should not remain as a public API. | No new package edges because app-runtime and adapters-tui already depend on `@nanoboss/procedure-sdk`. The owner remains below both consumers and adds no cycle. |
| Self-command resolution: `resolveSelfCommand` and runtime-testable variant | `packages/procedure-engine/src/self-command.ts` exports `resolveSelfCommand` and `resolveSelfCommandWithRuntime`, and `packages/procedure-engine/src/index.ts` publicly exports both. `packages/adapters-http/src/self-command.ts` and `packages/adapters-mcp/src/self-command.ts` export local `resolveSelfCommand` but keep their runtime variant private and do not publicly barrel-export the helper. `packages/agent-acp/src/runtime-capability.ts` embeds a private local `resolveSelfCommand` variant. | Procedure-engine worker dispatch uses it in `packages/procedure-engine/src/dispatch/jobs.ts`, and `packages/procedure-engine/tests/self-command.test.ts` imports the public runtime variant. HTTP private server registration uses its copy in `packages/adapters-http/src/private-server.ts`. MCP registration uses its copy in `packages/adapters-mcp/src/registration.ts`. Agent ACP default runtime capability uses the embedded copy in `packages/agent-acp/src/runtime-capability.ts`. | Procedure-engine, HTTP, and MCP copies are behavior-identical except only procedure-engine publicly exports the runtime-testable variant. Agent ACP's embedded variant has the same behavior inline. All copies honor `NANOBOSS_SELF_COMMAND` as an executable override with `[subcommand, ...args]`, otherwise use `process.execPath` plus `process.argv[1]`; source entrypoint mode uses the repository `nanoboss.ts` when the script path is an existing JS/TS file and not `/$bunfs/`; Bun no-script mode also uses `nanoboss.ts` when the executable contains `bun` and the source file exists; packaged mode falls back to `[subcommand, ...args]`. This is process-entrypoint/runtime policy, not procedure-engine behavior. | Move the resolver to `@nanoboss/app-support`, export both `resolveSelfCommand` and `resolveSelfCommandWithRuntime`, and update procedure-engine dispatch, HTTP private server, MCP registration, and agent-acp runtime capability imports. Keep protocol-specific command assembly in each adapter. Move or retarget the existing procedure-engine self-command tests to the app-support owner. | Keep a temporary `@nanoboss/procedure-engine` public re-export for both self-command functions because they are currently public and tested through `@nanoboss/procedure-engine`. HTTP, MCP, and agent-acp have no public self-command export to preserve. | Existing HTTP and MCP packages already depend on `@nanoboss/app-support`. Phase 4 must add `procedure-engine -> app-support` and `agent-acp -> app-support`, and update `tests/unit/package-dependency-direction.test.ts` allowed layering for those edges. Because `@nanoboss/app-support` has no workspace dependencies, the proposed graph remains acyclic. |

Dependency-direction confirmation:

- Current `bun test tests/unit/package-dependency-direction.test.ts` passes and the current allowed workspace layering graph is acyclic.
- Simulating the Phase 4 additions `procedure-engine -> app-support` and `agent-acp -> app-support` still produces no cycle because `@nanoboss/app-support` is a sink package.
- Data shape, text, error formatting, and tool payload normalization do not require new dependency edges beyond existing `@nanoboss/procedure-sdk` dependencies.

### Phase 2: converge pure text, error, and data-shape helpers

Likely implementation:

- Keep `summarizeText` and `formatErrorMessage` canonical in
  `@nanoboss/procedure-sdk`.
- Replace store and agent-acp local helper implementations with imports from
  the canonical owner.
- Move or re-home `inferDataShape` and `stringifyCompactShape` based on Phase 1,
  then update store, procedure-engine, and app-runtime memory-card consumers.
- Preserve existing behavior with focused tests before deleting duplicate
  files.

Acceptance:

- No duplicate `summarizeText` or `formatErrorMessage` implementation remains
  outside the canonical owner.
- `inferDataShape` has one canonical implementation and all current data-shape
  call sites import it.
- Existing result, session-store, memory-card, and procedure-engine recovery
  tests continue to pass.

### Phase 3: converge tool payload normalization

Likely implementation:

- Choose one canonical owner for adapter-neutral tool payload normalization.
- Move `ToolPayloadIdentity`, normalized payload shape, input normalization,
  result normalization, and tool error extraction to that owner when they are
  not UI-specific.
- Update `@nanoboss/app-runtime` tool-call previews and
  `@nanoboss/adapters-tui` tool-card formatting to import the shared
  normalizer.
- Keep TUI-only card layout, colors, truncation, and render decisions in
  `@nanoboss/adapters-tui`.

Acceptance:

- Only one implementation of `normalizeToolInputPayload` and
  `normalizeToolResultPayload` remains.
- App-runtime and TUI tests show the same raw tool payloads produce the same
  normalized headers, text, lines, and paths as before.
- No adapter imports a higher-level package solely to reach a helper.

### Phase 4: converge self-command resolution

Likely implementation:

- Centralize `resolveSelfCommand` and its runtime-testable variant in the owner
  selected during Phase 1.
- Update procedure-engine worker dispatch, HTTP adapter registration, MCP
  adapter registration, and agent-acp runtime capability construction to import
  the shared resolver.
- Preserve `NANOBOSS_SELF_COMMAND`, source-entrypoint detection, Bun virtual
  filesystem behavior, and packaged command behavior.
- Keep protocol-specific command assembly in the adapter packages.

Acceptance:

- Only one implementation of `resolveSelfCommand` and source-entrypoint
  detection remains.
- Existing procedure-engine self-command tests cover the canonical owner or are
  moved to the owner package.
- HTTP, MCP, procedure dispatch worker, and agent-acp runtime capability tests
  cover their protocol-specific use of the shared resolver.

### Phase 5: add duplicate-helper guardrails

Actions:

- Extend `tests/unit/procedure-engine-helper-convergence.test.ts` or add a new
  package-helper ownership test that scans repository TypeScript files for
  duplicate helper implementation names.
- Add explicit allowed-owner metadata for each helper family.
- Update dependency-direction allowed layering only where canonical owner
  imports require it.
- Update package public barrels so canonical helpers are exported intentionally
  and non-owner packages do not re-export accidental helper surfaces.

Acceptance:

- The known helper families cannot reappear in multiple package owners without
  editing the guardrail test and documenting the reason.
- Package dependency-direction validation remains acyclic.
- Public barrels expose helper APIs only from their canonical owner or from a
  deliberate compatibility re-export with a removal note.

## Test strategy

Run focused checks during the review:

```sh
bun test packages/procedure-sdk packages/store packages/agent-acp
bun test packages/procedure-engine packages/app-runtime packages/adapters-tui
bun test packages/adapters-http packages/adapters-mcp
bun test tests/unit/procedure-engine-helper-convergence.test.ts
bun test tests/unit/package-dependency-direction.test.ts
```

Run before commit:

```sh
bun run check:precommit
```

## Risks

- Choosing `@nanoboss/app-support` for too many helpers could turn it into a
  general utility bucket. Use it only when the helper is genuinely low-level and
  not procedure-specific.
- Moving `inferDataShape` may alter serialized data-shape previews if the
  current copies are not exactly equivalent.
- Tool payload normalization is shared behavior, but UI rendering is not. The
  move must not pull TUI presentation policy into a lower package.
- Self-command resolution is sensitive to development, packaged, and override
  execution modes. Tests should cover all existing branches before deleting
  copies.

## Out of scope

- Redesigning tool-card visuals or runtime event schemas.
- Changing stored session metadata format beyond preserving existing
  data-shape output.
- Changing adapter protocol behavior except where it imports the shared
  self-command resolver.
- Introducing a new general utilities package.

## Final acceptance criteria

- Each known duplicate helper family has exactly one canonical implementation
  or a documented, tested reason for multiple implementations.
- All consumers import helpers from the canonical owner through public package
  APIs.
- Duplicate-helper guardrails prevent the same helper families from drifting
  across packages again.
- `bun run check:precommit` passes.
