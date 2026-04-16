# PR #7 Review: Post-extraction convergence refactor

PR: [`plans-2026-04-15-post-extraction-convergence`](https://github.com/jflam/nanoboss/pull/7) — merged to `master` as `1c09528` on 2026-04-16.

- 30 commits, 241 files changed, +2,414 / −3,523 (net −1,109 LOC).
- Stated goal: "finish the inversion" so packages own behavior, the root app becomes a wiring layer, `src/core` disappears, and duplicated helpers collapse to a single owner so each package can be developed and tested in isolation.

This review assesses, concretely, how much of that goal landed and which gaps remain after the merge.

---

## 1. What the PR actually accomplishes

The plan in `plans/2026-04-15-post-extraction-convergence-plan.md` specifies six phases, each with acceptance criteria. The merged tree satisfies the structural ones:

### 1.1 `src/core` is gone

- `ls src/core` returns `No such file or directory`.
- `tests/unit/delete-remaining-src-core.test.ts` enforces this and also forbids any `from "…/src/core/…"` import, static or dynamic, anywhere in `src/`, `packages/`, `procedures/`, `scripts/`, `tests/`, and the root entry TS files.
- Root `src/` is down to 9 TypeScript files / 1,050 LOC, well under the plan's target of "fewer than 12 files / fewer than 1,000 lines" (files: ✓; LOC: slightly over, ~1,050 vs. 1,000).

```
src/app-support/build-freshness.ts
src/commands/{doctor,http,http-options}.ts
src/dev/build-size-report.ts
src/options/{frontend-connection,resume}.ts
src/util/{argv,compact-test}.ts
```

Every remaining root file is clearly app-entrypoint, command, option, or dev-tooling — exactly the "thin wiring layer" the plan wanted.

### 1.2 The reverse-import direction is fixed

- `grep -rn "from ['\"](\.\./)\+src/" packages/` returns zero hits.
- `@nanoboss/app-runtime` no longer pulls runtime helpers out of `src/core`; agent runtime instructions, memory cards, run events, runtime mode, tool-call preview, tool payload normalization, and the runtime prompt augmentation all now live inside `packages/app-runtime/src/`.
- The root entrypoint `nanoboss.ts` (and the sibling `.ts` files) contain no `packages/*/src/*` imports; everything flows through `@nanoboss/*` public entrypoints defined in each package's `index.ts`. This is verified by `tests/unit/public-package-entrypoints.test.ts`.

### 1.3 Compatibility shims are deleted

All seven one-line re-export files identified in the plan are gone (`src/agent/token-metrics.ts`, `src/core/service.ts`, `src/http/client.ts`, `src/http/server.ts`, `src/mcp/jsonrpc.ts`, `src/session/repository.ts`, `src/tui/controller.ts`). `public-package-entrypoints.test.ts` asserts each path's non-existence and pins every caller's new canonical import form.

### 1.4 Helper ownership is collapsed onto explicit owners

The plan's "frozen disposition map" is implemented. Concrete results:

| Concern | Canonical owner (post-PR) |
|---|---|
| Public prompt-input helpers (`createTextPromptInput`, `normalizePromptInput`, `promptInputDisplayText`, `hasPromptInputImages`, …) | `@nanoboss/procedure-sdk` |
| ACP prompt conversion / logging (`promptInputToAcpBlocks`, `summarizePromptInputForAcpLog`, `promptInputFromAcpBlocks`) and token metrics | `@nanoboss/agent-acp` |
| Runtime prompt augmentation | `@nanoboss/app-runtime` |
| Execution helpers (cancellation, error-format, timing-trace, logger, self-command, UI event formatting) | `@nanoboss/procedure-engine` |
| Durable settings, stored-value conversion, strict agent selection parsing, session repository | `@nanoboss/store` |
| Build-info, install-path, procedure-paths, workspace-identity | new `@nanoboss/app-support` package |
| Model catalog | `@nanoboss/agent-acp` (TUI and builtins now consume it) |
| Repo artifacts / repo fingerprint | `procedures/lib/` |

A family of "convergence" tests (`app-support-helper-convergence`, `store-helper-convergence`, `procedure-engine-helper-convergence`, `repo-helper-convergence`, plus the file-level owner table in `public-package-entrypoints.test.ts` — `PHASE_2_COLLAPSED_HELPER_FILES` and `PHASE_2_HELPER_FUNCTION_OWNERS`) pin these owners so regressions are caught mechanically.

### 1.5 Architecture is locked with regression tests

The new tests encode Phase 6's acceptance criterion — "CI fails on boundary regressions":

- `delete-remaining-src-core.test.ts` — `src/core/` stays deleted; no TS file may import from it.
- `root-owned-core-relocation.test.ts` — root-only command/support files must live under `src/commands`, `src/options`, `src/app-support`, or `src/dev`, not anywhere else.
- `public-package-entrypoints.test.ts` — deleted shim paths stay deleted; known callers use `@nanoboss/*` names; package `index.ts` files re-export collapsed implementations; helper function names resolve to exactly one owner file; and it scans for banned `packages/*/src/*` imports in root-level code.
- `app-support-helper-convergence`, `store-helper-convergence`, `procedure-engine-helper-convergence`, `repo-helper-convergence` — each verifies per-helper-family ownership.

All three primary architecture tests pass on `master` (`bun test tests/unit/delete-remaining-src-core.test.ts tests/unit/public-package-entrypoints.test.ts tests/unit/root-owned-core-relocation.test.ts` → 3 pass / 0 fail, 2537 expect() calls). `bun run typecheck` also passes.

### Verdict on the stated goal

Against the plan's own acceptance criteria, the merge lands cleanly. The structural "inversion" is real:

- package code no longer imports from root `src/`
- root code no longer imports package internals
- `src/core` is gone rather than shrunk
- each helper family has exactly one owner file
- boundary enforcement is mechanized

That is substantial and the PR description's claim ("this is the point where the extraction becomes real") is accurate with respect to import shape and ownership mapping.

---

## 2. Gaps remaining

The refactor succeeded at ownership and import topology. It stopped short of making packages *independently developable and testable*, and it left a small set of concrete residues that will accumulate tech debt if not addressed.

### 2.1 Packages still cannot be developed or tested in isolation (biggest gap)

This is the gap most directly opposed to the user-stated goal of the PR ("developed and tested in isolation").

Concrete evidence:

- **No per-package test suite.** All 97 `*.test.ts` files live in the root `tests/` directory. `find packages -name '*.test.ts'` returns zero results. There is no `packages/<name>/tests/` anywhere.
- **No per-package scripts.** None of the 12 package `package.json` files has a `test`, `typecheck`, `build`, or `lint` script. They declare nothing but `name`, `type`, `exports`, and workspace deps. There is no way to say "test only `@nanoboss/store`" short of running a filtered `bun test` against root tests that happen to exercise it.
- **Tests depend on root-owned code.** Many tests still import from `../../src/...` (e.g. `src/commands/doctor.ts`, `src/options/frontend-connection.ts`, `src/app-support/build-freshness.ts`, `src/util/argv.ts`, `src/dev/build-size-report.ts`, `src/util/compact-test.ts`). That is defensible for root-owned behavior but means a package checkout on its own would still be non-functional.
- **Package tsconfigs are leaves of the root tsconfig.** Every `packages/*/tsconfig.json` does `"extends": "../../tsconfig.json"` and overrides `baseUrl` to `../..` so the root path map (`@nanoboss/*` → `./packages/*/src/index.ts`) resolves. That is fine for a monorepo but it means a package's types cannot be checked without the root file present. Combined with the lack of per-package `typecheck` scripts, there is no meaningful "package in isolation" TypeScript experience today.
- **`@nanoboss/app-support` has no `tsconfig.json` at all.** Every other package has one. This is an inconsistency the convergence tests do not catch.

In short: package *source* was isolated, but package *engineering* was not. The next logical step — per-package `tests/`, per-package `typecheck`/`test` scripts, and a tsconfig project-references layout — was not taken.

### 2.2 Dependency direction among packages is not enforced and has questionable edges

There is no DAG check. The convergence tests verify *where a helper lives*, not *who is allowed to depend on whom*. The current graph (from each package's `package.json`) contains several edges that are worth revisiting:

- `@nanoboss/procedure-engine` depends on `@nanoboss/agent-acp`. An agent-protocol adapter is a reasonable engine dependency only if the engine is intentionally ACP-specific; otherwise this couples the execution core to one concrete agent transport.
- `@nanoboss/agent-acp` depends on `@nanoboss/store`. A wire-format / protocol package pulling in durable storage is unusual; stored-value types may be the driver, but this wants to be either a thinner dependency (on `contracts`/`procedure-sdk`) or an explicit acknowledgment that `agent-acp` knows about durable kernel values.
- `@nanoboss/adapters-acp-server` depends on `@nanoboss/app-runtime`. An adapter depending on the app-level runtime inverts the usual direction (adapters are typically below the runtime). Whether intentional or not, the current shape pulls the whole runtime into the ACP server adapter, which limits how independently that adapter can be consumed.
- `@nanoboss/store` depends on `@nanoboss/procedure-sdk` and `@nanoboss/app-support`. A pure persistence layer depending on the SDK's value types is defensible; depending on `app-support` (build-info, install-path, workspace-identity) is less obviously correct.

A lint-style check such as `rg "from ['\"]\@nanoboss/" packages/<name>/src` compared against the declared `dependencies` in that package's `package.json`, plus an explicit allow-list of edges (a "layering" doc or a tiny architecture test), would catch both accidental new edges and undeclared deps.

### 2.3 Duplicate helpers that survived the collapse

The convergence map is mostly enforced for the helpers it explicitly names, but two duplications remain in the tree:

- `toPublicRunResult<T>(...)` exists in both `packages/agent-acp/src/run-result.ts` and `packages/procedure-engine/src/run-result.ts`. A `diff` shows the bodies overlap substantially; the `procedure-engine` copy additionally exports `runResultFromRunRecord`, so the two files share a helper while the engine file carries extra logic on top.
- `inferDataShape(value, depth=0)` exists in both `packages/store/src/data-shape.ts` and `packages/procedure-engine/src/data-shape.ts`. Same function name, same signature; `procedure-engine` additionally exports `stringifyCompactShape`.

Neither of these is caught by the convergence tests because the tests key on file names in a closed list (`PHASE_2_COLLAPSED_HELPER_FILES`) and on a small set of named functions (`PHASE_2_HELPER_FUNCTION_OWNERS`). `run-result.ts` and `data-shape.ts` are not in either map, so two owners each remain legal.

Per the plan's Rule for Phase 2 ("no helper exists in both root `src/` and a package tree"), this technically isn't a violation — but in spirit it reintroduces the same duplicate-helper problem across packages that the refactor removed between root and packages.

Recommended fix: pick the lower-layer owner (likely `store` for `inferDataShape`, likely `procedure-sdk` or `store` for `toPublicRunResult`), add those filenames / function names to the convergence tables, and have the other package re-export.

### 2.4 Empty directories in `src/`

After the moves, the tree retains empty folders:

```
src/runtime                             # empty
src/tui/clipboard                       # empty
src/tui/components/tool-renderers       # empty
src/tui/overlays                        # empty
```

These exist because git tracks files, not directories, but bun/TypeScript tooling can still walk into them and they read as dead navigation targets in any editor. Removing them is a one-liner and the convergence tests should probably assert the root `src/` tree matches a small known list.

### 2.5 The `src/core` test catches imports but not equivalents

`delete-remaining-src-core.test.ts` bans three patterns: static `from "…/src/core/…"`, side-effect `import "…/src/core/…"`, and dynamic `import("…/src/core/…")`. It does not ban:

- string-literal references (e.g. in documentation / error messages / code generators),
- `require("…/src/core/…")` in CommonJS escape hatches (none today, but nothing prevents one),
- non-TypeScript files (`procedures/*.md` or generated code).

None of these is exploited today, but the test is narrower than its name suggests. A follow-up could just glob for the string `src/core/` across all repo files and allow-list the one or two places (e.g. the test itself, the plan markdown) that must contain it.

### 2.6 `@nanoboss/app-support` is inconsistently set up

- No `tsconfig.json` (every other package has one).
- No `dependencies` block at all (not even `@nanoboss/contracts`), which is fine only if the package genuinely depends on nothing.
- It is used by `@nanoboss/store`, `@nanoboss/procedure-catalog`, `@nanoboss/app-runtime`, `@nanoboss/agent-acp`'s graph, and the root app. That is a lot of reverse pull for a helper bucket created mid-refactor; if any of those dependents is intended to stay lean, `app-support` needs clearer scoping.

### 2.7 Knip / lint / build parity with the new shape

- The PR updates `knip.json` in passing, but there is no convergence test for "every package `index.ts` actually re-exports every public helper named in `PHASE_2_HELPER_FUNCTION_OWNERS`". The function-owner test proves the helper is implemented in the right file, not that it is reachable through the package's public entrypoint. A caller outside the workspace could still have to import `@nanoboss/store/src/settings.ts` directly.
- There is no `build` script or emitted `dist/` per package; the root `build.ts` still bundles the whole app. That's consistent with the monorepo choice but it means a package consumer outside this repo does not exist — which is fine today, but it is the real bar for "developed and tested in isolation".

---

## 3. Risk and maintainability notes

- **The convergence tests are large and concrete.** `public-package-entrypoints.test.ts` (284 LOC) hard-codes specific import snippets across both product and test files. When any of those imports is legitimately edited, the architecture test will fail in a non-obvious way. This is a good trade-off for now, but the test will need refactoring into a more declarative "allowed imports" table before the codebase grows much more.
- **Helper ownership is expressed as a denylist plus a hand-maintained function-name → file map.** That scales to O(100) helpers before it becomes the maintenance problem it is designed to prevent. A dependency-cruiser-style or ts-morph-based check with a declarative layering file would age better.
- **Package tests do not exercise packages through their `index.ts`.** Root-level tests mostly do the right thing after this PR (the convergence tests enforce canonical `@nanoboss/*` imports in the tests they know about), but there is no blanket rule. A helper could be public-by-accident — exported from `index.ts` yet unused — and nothing would flag it. `knip --production` is run via `bun run knip`, but only at the root.

---

## 4. Recommended follow-ups (in priority order)

1. **Make packages independently testable.** Move package-relevant tests into `packages/<name>/tests/`, add a `"test": "bun test"` (and `"typecheck": "tsc -p tsconfig.json --noEmit"`) script to each package's `package.json`, and wire a root meta-command that fan-outs. This is the single change that would make the PR's user-facing goal actually true.
2. **Add a package dependency-direction test.** Walk `packages/*/src/**/*.ts`, collect `@nanoboss/*` imports, compare against the declared `dependencies` in the sibling `package.json`, and additionally assert the declared graph is a DAG matching an explicit `ALLOWED_LAYERING` table. This closes the "ownership is right, direction is unchecked" gap and would immediately flag §2.2 for discussion.
3. **Collapse the two surviving duplicates** (`toPublicRunResult`, `inferDataShape`) and extend `PHASE_2_COLLAPSED_HELPER_FILES` / `PHASE_2_HELPER_FUNCTION_OWNERS` to cover `run-result.ts` and `data-shape.ts` so the same drift cannot recur.
4. **Give `@nanoboss/app-support` a `tsconfig.json`**, an explicit `dependencies` block, and a convergence test entry, so its setup matches the other 11 packages.
5. **Delete the four empty `src/` directories** and extend `root-owned-core-relocation.test.ts` to assert `src/` contains only the allowed subdirectories (`app-support`, `commands`, `dev`, `options`, `util`).
6. **Tighten the `src/core` regression test** to ban the literal string `src/core/` in any tracked file outside a small allow-list.
7. **Add a public-surface test**: for each helper in `PHASE_2_HELPER_FUNCTION_OWNERS`, assert it is re-exported through the owning package's `index.ts`. Today we only prove it *lives* in the right file.

Items 1 and 2 are the ones most directly tied to the user's stated goal. The rest are hygiene that keeps the converged shape from drifting.

---

## 5. Summary

PR #7 delivers its stated structural claims: `src/core` is removed, every converged helper has exactly one owner, root entrypoints consume package public APIs, the reverse-import direction is gone, and architecture tests enforce those invariants. Against the plan-document's acceptance criteria, the refactor is complete.

Against the broader goal the user articulated — "refactoring code into independent packages that ideally can be developed and tested in isolation" — the PR lands the *ownership* half of that and stops at the *engineering* half. Packages are now clearly scoped and import-enforced, but they still share a single root tsconfig project, a single root test suite, a single root build, no per-package scripts, and an unverified dependency graph. The biggest follow-up is not a cleanup but a small tooling investment: per-package test dirs, per-package `typecheck`/`test` scripts, and a mechanical dependency-direction check. With those added, the packages would actually be developable and testable in isolation, not merely source-isolated.
