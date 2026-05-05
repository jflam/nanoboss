# `@nanoboss/procedure-catalog`

`@nanoboss/procedure-catalog` is the procedure discovery and registry package.
It turns builtin, profile, repo-local, and persisted procedure modules into a
single `ProcedureRegistry` that runtimes and the procedure engine can use.

It owns:

- procedure registry state
- builtin procedure registration
- disk procedure discovery and lazy loading
- procedure source persistence paths
- procedure metadata projection for command lists
- procedure name normalization and file-path derivation
- the small loadable-registry contract needed by the built-in create procedure

It does not own:

- procedure authoring contracts
- procedure execution semantics
- procedure runtime context implementations
- durable run/ref/session storage
- app-runtime session orchestration
- adapter command rendering or transport envelopes
- generic disk-module loading mechanics

Those boundaries matter:

- `@nanoboss/procedure-sdk` owns `Procedure`, `ProcedureMetadata`, and
  procedure-facing helper contracts.
- `@nanoboss/app-support` owns generic disk loading and workspace path roots.
- `@nanoboss/procedure-engine` owns execution once a procedure is selected.
- `@nanoboss/app-runtime` decides when to load the registry and how to expose
  registry results to clients.

## Public Interface

The public entrypoint is `packages/procedure-catalog/src/index.ts`.

### Registry

- `ProcedureRegistry`
- `projectProcedureMetadata(...)`
- `toAvailableCommand(...)`

`ProcedureRegistry` is the main package surface. It supports direct
registration, builtin registration, disk loading, lazy loading, and persistence
for generated procedures.

`projectProcedureMetadata(...)` is the shared filtering helper for command
surfaces. By default it hides the `default` procedure from slash-command lists.

`toAvailableCommand(...)` converts procedure metadata into the ACP command shape
used by app-runtime continuation and command-list projection.

### Loadable registry contract

- `LoadableProcedureRegistry`
- `assertProcedureSupportsResume(...)`

The built-in create procedure only needs a narrow loadable/persisting registry
interface, not the full concrete `ProcedureRegistry`. The procedure engine uses
`assertProcedureSupportsResume(...)` before resuming lazy-loaded procedures.

### Disk loading and persistence

- `loadProcedureFromPath(...)`
- `persistProcedureSource(...)`

These are the public disk-module operations. The lower-level
`discoverDiskProcedures(...)` function stays private to the registry because it
exposes registry discovery mechanics rather than a stable caller workflow.

Generic transpilation and module-default extraction live in
`@nanoboss/app-support`; this package supplies procedure validation and
procedure-specific metadata rules.

### Builtins and runtime path

- `CREATE_PROCEDURE_METADATA`
- `getProcedureRuntimeDir()`

The create-procedure metadata is exported because tests and builtin registry
coverage assert the public builtin command contract. Runtime-path resolution is
used by the build script when preparing procedure runtime assets.

### Procedure names

- `normalizeProcedureName(...)`
- `resolveProcedureEntryRelativePath(...)`
- `resolveProcedureImportPrefix(...)`

These helpers are the canonical procedure-name owner. Procedure generation and
source persistence should use them instead of duplicating slash/segment/path
logic.

## Package Structure

- `src/registry.ts`
  Concrete procedure registry, lazy procedure wrappers, metadata projection, and
  ACP command conversion.
- `src/builtins.ts`
  Builtin procedure registration, including the create procedure adapter.
- `src/disk-loader.ts`
  Procedure-specific discovery metadata, validation, load, and source
  persistence.
- `src/loadable-registry.ts`
  Small registry interface and resume guard.
- `src/names.ts`
  Procedure name normalization and generated-file path helpers.
- `src/paths.ts`
  Procedure runtime directory re-export from app-support.

## Runtime Flow

Foreground app-runtime flow:

1. `NanobossService` constructs `ProcedureRegistry`.
2. It calls `loadBuiltins()`.
3. When disk commands are enabled, it calls `loadFromDisk()`.
4. Runtime command lists use `projectProcedureMetadata(...)` and
   `toAvailableCommand(...)`.
5. Selected procedures run through `@nanoboss/procedure-engine`.

Async dispatch flow:

1. `ProcedureDispatchJobManager` creates a registry for worker execution.
2. The registry loads builtins and disk procedures.
3. The dispatch worker resolves the selected procedure by name.
4. Execution transfers to procedure-engine.

Create-procedure flow:

1. The built-in create procedure generates a source module.
2. It normalizes the generated name through `normalizeProcedureName(...)`.
3. It persists source through the loadable registry.
4. It loads the generated module back through the registry to validate the
   generated procedure before returning success.

## Simplification Rules

- Keep registry workflows public; keep registry discovery internals private.
- Put generic filesystem, cache, and transpilation mechanics in
  `@nanoboss/app-support`.
- Put procedure authoring and result helpers in `@nanoboss/procedure-sdk`.
- Procedure creation code should import name/error helpers from their canonical
  owners instead of carrying local copies.
- Do not let adapters import disk-loader internals. Adapters should receive
  procedure metadata and runtime events from app-runtime.

## Current Review Metrics

Measured during the 2026-05 procedure-catalog review:

- source files: 7
- source lines: 639
- largest file: `src/builtins.ts` at 220 lines
- public procedure-catalog symbols: reduced from 13 to 12
- duplicated helper implementations removed from `procedures/create.ts`: 2
- `procedures/create.ts` line count reduced by 57 lines

The change keeps name normalization and error formatting at their canonical
owners, and it keeps disk discovery behind the registry surface rather than
making it part of the package entrypoint.

## Good Future Targets

- Reconsider whether `CREATE_PROCEDURE_METADATA` should remain public or become
  a registry-observable contract asserted through `ProcedureRegistry`.
- Split builtin create-procedure wiring if `src/builtins.ts` grows beyond simple
  adapter code around `procedures/create.ts`.
- Keep `discoverDiskProcedures(...)` private unless a real caller needs raw
  discovery without registry semantics.
