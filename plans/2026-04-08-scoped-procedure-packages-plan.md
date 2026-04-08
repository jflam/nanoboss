# Scoped procedure packages plan

## Problem

Nanoboss now has a clearer implementation split between built-in procedure packages in `packages/` and disk-loaded procedures under hidden `.nanoboss/procedures/` roots, but the user-facing procedure names are still mostly flat:

- `/kb-answer`
- `/kb-ingest`
- `/autoresearch-start`
- `/autoresearch-continue`

That no longer matches the code layout well. `autoresearch` is already implemented as a package, and `kb` already has shared code under `packages/kb/lib/`, but the command surface still exposes flat hyphenated names instead of package-scoped names.

## Goal

Make package structure and slash-command structure line up:

- `/kb/answer`
- `/kb/ingest`
- `/kb/render`
- `/autoresearch/start`
- `/autoresearch/continue`
- `/autoresearch/status`

Assume a direct migration without backward-compatibility aliases unless a concrete technical reason appears during implementation.

## Proposed canonical naming

### Autoresearch

- `/autoresearch`
- `/autoresearch/start`
- `/autoresearch/continue`
- `/autoresearch/status`
- `/autoresearch/clear`
- `/autoresearch/finalize`

`/autoresearch` can stay as the overview/help entrypoint implemented by `packages/autoresearch/index.ts`.

### Knowledge base

Minimum-scoped version:

- `/kb/ingest`
- `/kb/compile-source`
- `/kb/compile-concepts`
- `/kb/link`
- `/kb/render`
- `/kb/health`
- `/kb/refresh`
- `/kb/answer`

This is the smallest change that makes the package boundary explicit without introducing a second hierarchy layer such as `/kb/compile/source`.

## Target filesystem layout

### Built-ins

```text
packages/
  kb/
    answer.ts
    ingest.ts
    compile-source.ts
    compile-concepts.ts
    link.ts
    render.ts
    health.ts
    refresh.ts
    lib/
      repository.ts
  autoresearch/
    index.ts
    start.ts
    continue.ts
    status.ts
    clear.ts
    finalize.ts
    runner.ts
    ...
```

### Disk-loaded procedures

```text
.nanoboss/
  procedures/
    kb/
      answer.ts
      ingest.ts
      ...
    autoresearch/
      start.ts
      continue.ts
      ...
```

That keeps the user-installed procedure root package-oriented: one directory per package, with one or more entrypoint files inside.

## Implementation phases

### 1. Rename built-in KB entrypoints into a real `packages/kb/` package

- Move flat files like `packages/kb-answer.ts` into `packages/kb/answer.ts`
- Update imports in `src/procedure/registry.ts`
- Keep helper code in `packages/kb/lib/`

This should happen before renaming user-facing procedure names, so the filesystem already matches the intended scope.

### 2. Rename canonical procedure names to slash-scoped names

- Change `Procedure.name` values from `kb-answer` to `kb/answer`
- Change autoresearch subcommands from `autoresearch-start` to `autoresearch/start`
- Keep `/autoresearch` as the package overview entrypoint

This should update:

- procedure registration
- command parsing expectations
- command listings
- tests and fixtures
- docs and example prompts

### 3. Decide and implement disk persistence mapping for scoped names

Current generated procedures are persisted as one package per procedure:

- `procedures/<name>/index.ts`

For scoped names, decide between:

1. `procedures/kb/answer.ts`
2. `procedures/kb/answer/index.ts`

Recommendation: use `procedures/<package>/<leaf>.ts` for scoped procedures because it matches the desired “one package directory, multiple entrypoints inside” model better.

If that is adopted:

- `/create review` -> `procedures/review/index.ts` or `procedures/review.ts` (choose one and document it)
- `/create kb/answer` -> `procedures/kb/answer.ts`

The key point is that persistence should reflect package ownership, not treat every scoped procedure as an entirely separate top-level package.

### 4. Update `/create` to understand scoped names

`sanitizeProcedureName(...)` currently strips `/`, so it must be relaxed.

Needed work:

- allow slash-delimited procedure names
- validate each path segment
- normalize repeated or leading/trailing slashes
- persist scoped names into the chosen disk package layout
- rewrite generated import paths correctly for the persisted location

### 5. Update UI and integration surfaces

Review all places that render or parse command names:

- `src/core/service.ts`
- ACP command descriptors
- MCP procedure metadata
- TUI command palette/autocomplete
- docs and README examples
- tests that assert exact command names

The parser likely already tolerates `/kb/answer` because it treats everything after the first `/` up to whitespace as the command name, but that should be verified explicitly.

### 6. Remove flat-name assumptions from tests and docs

Update:

- unit tests that assert names like `kb-answer`
- any hard-coded slash command examples
- package-structure documentation
- research/plan docs only where keeping the old names would be actively misleading

## Specific files likely to change

- `src/procedure/registry.ts`
- `src/procedure/create.ts`
- `src/core/service.ts`
- `src/mcp/server.ts`
- `src/http/frontend-events.ts`
- `src/tui/*`
- `tests/unit/registry.test.ts`
- `tests/unit/service.test.ts`
- `tests/unit/knowledge-base-commands.test.ts`
- `README.md`
- `docs/procedure-packages.md`
- built-in KB files under `packages/`

## Design decisions to make early

1. **Canonical KB form**
   - `/kb/answer` etc. seems best
   - defer deeper nesting like `/kb/compile/source`

2. **Disk file layout for scoped procedures**
   - prefer package directory + leaf files

3. **Single-procedure generated packages**
   - decide whether unscoped procedures remain `procedures/foo/index.ts`
   - or simplify to `procedures/foo.ts`

4. **Compatibility**
   - current assumption: no aliases, no transition layer

## Recommended execution order

1. Move KB entrypoints into `packages/kb/`
2. Rename built-in procedure names to slash-scoped forms
3. Update registry/tests/docs for the new names
4. Update `/create` and persistence rules for scoped names
5. Re-run lint/build/tests

## Notes

- The recent `packages/` and hidden `.nanoboss/procedures/` refactor was the right prerequisite for this work.
- The remaining inconsistency is mostly naming and persistence semantics, not loader capability.
- This change is now primarily about making the external command surface match the internal package model.
