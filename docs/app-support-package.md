# `@nanoboss/app-support`

`@nanoboss/app-support` is the low-level support package for process,
filesystem, workspace, and repository primitives that multiple Nanoboss
packages need. It exists to keep duplicated support helpers out of adapters,
runtime code, procedure catalogs, and procedures.

It owns:

- build metadata lookup
- self-command resolution for worker and server re-entry
- disk module discovery/loading support shared by procedure and extension
  catalogs
- Nanoboss home/runtime directory paths
- install-path selection
- procedure and extension workspace roots
- repo artifact directories and atomic file writes
- repo fingerprinting and workspace identity
- timing trace file writes for cross-package latency diagnostics

It does not own:

- general-purpose formatting helpers
- procedure authoring contracts
- procedure execution or runtime policy
- persisted session/run schema
- adapter protocol behavior
- UI rendering or extension activation policy

The package should stay boring and low-level. If a helper is not about process
entrypoints, filesystem paths, disk loading, repo/workspace identity, atomic
repo files, or low-level diagnostic file writes, it probably belongs somewhere
else.

## Public Interface

The public entrypoint is `packages/app-support/src/index.ts`.

### Build metadata

- `getBuildCommit()`
- `getBuildLabel()`

Used by adapters and runtime descriptors to show the running Nanoboss build
without each caller knowing the build-info source.

### Self-command resolution

- `resolveSelfCommand(...)`
- `resolveSelfCommandWithRuntime(...)`
- `SelfCommand`
- `SelfCommandRuntime`

This is the canonical owner for process re-entry. Procedure dispatch workers,
HTTP private-server registration, MCP registration, and agent runtime
capability code import this helper instead of reconstructing the same
`process.execPath` / source-entrypoint logic locally.

### Disk module loading

- `discoverDiskModules(...)`
- `loadDiskModule(...)`
- `getDiskModuleDefaultExport(...)`
- disk module parameter/result types

Procedure and TUI extension catalogs both need the same filesystem discovery
and Bun plugin setup. This package owns the generic loader mechanics; catalogs
own validation, registry, precedence, and activation policy.

`createTypiaBunPlugin(...)` remains internal because it is an implementation
detail of disk loading, not a standalone app-support contract.

### Nanoboss home and install paths

- `getNanobossHome()`
- `getNanobossRuntimeDir()`
- `resolveNanobossInstallDir(...)`
- `InstallPathOptions`

These helpers centralize user-profile and executable-install paths. The
`splitPath(...)` helper is intentionally private; callers should use
`resolveNanobossInstallDir(...)` so PATH parsing and install preference stay in
one place.

### Procedure and extension roots

- `detectRepoRoot(...)`
- `resolveRepoProcedureRoot(...)`
- `resolveProfileProcedureRoot(...)`
- `resolvePersistProcedureRoot(...)`
- `resolveWorkspaceProcedureRoots(...)`
- `resolveRepoExtensionRoot(...)`
- `resolveProfileExtensionRoot(...)`
- `resolveWorkspaceExtensionRoots(...)`

These helpers answer where Nanoboss should look for local/profile/persisted
procedures and extensions. Discovery order belongs here; loading and registry
semantics belong to the catalog packages.

### Repo artifacts and workspace identity

- `resolveRepoArtifactDir(...)`
- `ensureDirectories(...)`
- `ensureFile(...)`
- `writeTextFileAtomicSync(...)`
- `writeJsonFileAtomicSync(...)`
- `writeJsonFileAtomic(...)`
- `computeRepoFingerprint(...)`
- `getWorkspaceIdentity(...)`
- `resolveWorkspaceKey(...)`
- `computeProceduresFingerprint(...)`

These helpers are shared by store code, procedure support files, and review
procedures that need stable repo-local artifacts without duplicating atomic
write or fingerprint behavior.

### Timing traces

- `createRunTimingTrace(...)`
- `appendTimingTraceEvent(...)`
- `RunTimingTrace`

These helpers append JSONL timing events under a session root. They are shared by
agent and procedure execution packages so trace buffering, directory creation,
and file layout stay in one low-level owner.

## Package Structure

- `src/build-info.ts`
  Build label and commit helpers.
- `src/self-command.ts`
  Process re-entry command resolution.
- `src/disk-loader.ts`
  Generic disk module discovery, transpilation, and loading.
- `src/disk-build-diagnostics.ts`
  Private Bun build-log extraction and diagnostic formatting for disk loading.
- `src/disk-source-graph.ts`
  Private local-import graph resolution used by disk module cache keys.
- `src/disk-build-workspace.ts`
  Private disk-build workspace root detection and temporary dependency overlays.
- `src/typia-bun-plugin.ts`
  Private Bun plugin used by disk loading.
- `src/nanoboss-home.ts`
  User-profile Nanoboss paths.
- `src/install-path.ts`
  Executable install directory selection.
- `src/procedure-paths.ts`
  Procedure root resolution.
- `src/extension-paths.ts`
  Extension root resolution.
- `src/path-utils.ts`
  Private path helper functions shared by path modules.
- `src/repo-artifacts.ts`
  Repo artifact directories and atomic writes.
- `src/repo-fingerprint.ts`
  Git/filesystem fingerprinting.
- `src/workspace-identity.ts`
  Workspace keys and procedure fingerprints.
- `src/timing-trace.ts`
  Shared JSONL timing trace writer.

## Dependency Model

`@nanoboss/app-support` has no workspace package dependencies. That is
intentional: it is a sink package in the workspace graph, so higher packages can
depend on it without creating cycles.

Do not add a workspace dependency here unless the package's role is being
reconsidered. A support helper that requires runtime, store, procedure, or
adapter types is probably too high-level for this package.

## Simplification Rules

- Export high-level support capabilities, not their parser subroutines.
- Keep package-owned helper files focused by noun: build info, paths, disk
  loading, repo artifacts, repo fingerprinting, workspace identity, timing
  traces.
- Do not put generic text, error, data-shape, or tool payload helpers here.
  Those belong to `@nanoboss/procedure-sdk` when they are procedure/result
  contracts.
- Catalog packages may use disk-loader and path helpers, but catalog validation
  and activation policy should remain in the catalog packages.
- Adapters may use build/self-command/path helpers, but protocol-specific
  command assembly should remain in adapters.

## Current Review Metrics

Measured during the 2026-05 app-support review:

- source files: 17
- source lines: 1,612
- largest file: `src/disk-build-workspace.ts` at 312 lines
- workspace package dependencies: 0
- public app-support runtime value exports: 30
- internalized implementation helpers: `splitPath(...)` and
  `createTypiaBunPlugin(...)`
- code simplification applied: centralized duplicated `timing-trace.ts`
  implementations from `agent-acp` and `procedure-engine`

This is a surface-area cleanup, not a behavior change. The higher-level
install-path and disk-loader APIs still cover the same behavior, while callers
no longer see parser/plugin details as public app-support capabilities. Timing
trace helpers are exposed because multiple higher packages need the same
diagnostic file writer.

## Good Future Targets

- Review whether `disk-build-workspace.ts` should split scoped package overlays
  from generic temporary symlink cleanup if the build-environment setup grows.
- Keep `path-utils.ts` private; if a path helper becomes public, document the
  package-level behavior it represents rather than exporting a raw utility.
- Revisit repo fingerprinting after any new artifact-producing procedures are
  added, so app-support remains the canonical artifact/fingerprint owner.
