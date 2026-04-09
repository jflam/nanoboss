# Pre-commit-checks and commit fingerprint plan

Date: 2026-04-09

## Goal

Introduce two procedures for this repo:

- `pre-commit-checks`
- `commit`

Both procedures should share a deterministic `workspaceStateFingerprint` and use it to avoid rerunning identical `bun test` commands when the workspace state has not changed.

This plan is intentionally narrow for v1:

- repo-specific
- Bun-specific
- exact command matching only
- replay the **full cached output of the previous `bun test` run** for the same workspace state

This is not intended to be a generic checks framework yet. The point is to prove the value in nanoboss first.

---

## Motivation

Agents in this repo currently do this pattern often:

1. run `bun test ...`
2. inspect diffs / think / prepare next step
3. rerun the same `bun test ...`
4. get the same output because the repo contents did not change

That wastes:
- wall-clock time
- tokens spent waiting on test reruns
- attention during commit flows

We want nanoboss to recognize:

> “This exact `bun test` command was already run against this exact workspace state under this exact Bun/runtime identity, and the output is already known.”

When that is true, nanoboss should replay the cached output instead of rerunning the test command.

---

## Product surface

## Procedure 1: `pre-commit-checks`

Purpose:
- run or replay the repo’s pre-commit validation command
- in v1, that means `bun test` (or exact file-scoped `bun test ...` invocations)

Behavior:
1. compute `workspaceStateFingerprint`
2. compute `runtimeFingerprint`
3. compute `commandFingerprint`
4. look up cached result
5. if exact match exists:
   - replay cached output
   - return cached exit code and summary
6. otherwise:
   - run `bun test ...`
   - cache output + exit code + metadata
   - return fresh result

## Procedure 2: `commit`

Purpose:
- create a commit, but first ensure the current workspace state has a known `bun test` result

Behavior:
1. compute same fingerprints
2. look for cached `bun test` result for current state
3. if present:
   - replay cached output
   - if cached result failed, block commit unless overridden
   - if cached result passed, continue
4. if absent:
   - invoke `pre-commit-checks`
   - proceed only if result passed
5. create the commit

---

## Core design

## Shared fingerprint model

We need a robust workspace-state identity for dirty working trees.

For v1, use the more sophisticated Git-aware fingerprint:

```text
workspaceStateFingerprint = hash(
  headCommit,
  stagedDiffHash,
  unstagedDiffHash,
  untrackedRelevantFilesHash
)
```

This is stronger than using only `HEAD` or only `git diff`.

### Components

#### 1. `headCommit`

Source:
- `git rev-parse HEAD`

Why:
- identifies the tracked baseline

#### 2. `stagedDiffHash`

Source:
- hash of `git diff --cached --binary HEAD`

Why:
- commit flows care about what is staged

#### 3. `unstagedDiffHash`

Source:
- hash of `git diff --binary`

Why:
- working-tree changes also affect whether a previously-run test result is still valid

#### 4. `untrackedRelevantFilesHash`

Source:
- deterministic listing of untracked files plus their contents

Why:
- agents often add new tests/files before commit
- those files would not be captured by `HEAD` + diffs alone

### Relevant-file policy for v1

Include untracked files that are plausibly source-affecting in this repo, e.g.:
- `*.ts`
- `*.tsx`
- `*.js`
- `*.jsx`
- `*.json`
- `*.md` only if we decide docs can affect checks later

For v1, since the focus is `bun test`, we can keep this simple and include:
- all untracked files except ignored/generated directories

Exclude:
- `.git/`
- `node_modules/`
- `.nanoboss/`
- `dist/`
- `coverage/`
- temp files

---

## Additional fingerprints

### `runtimeFingerprint`

For v1, derive from:
- `Bun.version`
- `process.platform`
- `process.arch`

This avoids reusing cached output across materially different runtimes.

### `commandFingerprint`

Normalize and hash the exact `bun test` invocation.

Examples:
- `bun test`
- `bun test tests/unit`
- `bun test tests/unit/service.test.ts`

Each exact command gets a separate cache identity.

For v1, do **not** attempt subset/superset coverage reasoning.

---

## Cache semantics

The user clarified an important requirement:

> do not just cache success; cache the output of the previous Bun test run

So the cache must store the **full previous result**, including failures.

### Cache entry shape

Suggested repo-local cache file:
- `.nanoboss/pre-commit-checks.json`

Suggested schema:

```ts
interface CachedBunTestResult {
  workspaceStateFingerprint: string;
  runtimeFingerprint: string;
  commandFingerprint: string;
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  combinedOutput: string;
  summary: string;
  createdAt: string;
  durationMs: number;
}

interface PreCommitChecksCache {
  version: 1;
  updatedAt: string;
  entries: CachedBunTestResult[];
}
```

### Replay policy

If fingerprints match exactly, replay:
- cached output
- cached summary
- cached exit code

That means:
- a previous pass is replayed as a pass
- a previous failure is replayed as a failure

This is the correct v1 behavior because the goal is:

> avoid rerunning identical tests for identical contents

not:

> only remember good news

### Refresh escape hatch

Both procedures should allow forcing a real rerun even on a cache hit.

For example:
- `--refresh`
- `force: true`

Useful when:
- investigating flakiness
- validating after environment suspicion
- wanting a fresh timing sample

---

## Where the shared logic should live

Add a shared helper module, e.g.:

- `src/core/workspace-state-fingerprint.ts`

Responsibilities:
- compute `workspaceStateFingerprint`
- normalize exact `bun test` command text
- compute `commandFingerprint`
- compute `runtimeFingerprint`
- expose reusable helpers for both procedures

Potential API:

```ts
interface WorkspaceStateFingerprintResult {
  repoRoot: string;
  headCommit: string | null;
  stagedDiffHash: string;
  unstagedDiffHash: string;
  untrackedRelevantFilesHash: string;
  workspaceStateFingerprint: string;
}

function computeWorkspaceStateFingerprint(cwd: string): WorkspaceStateFingerprintResult;
function computeRuntimeFingerprint(): string;
function computeCommandFingerprint(command: string): string;
```

---

## `pre-commit-checks` procedure design

### Inputs

For v1:
- default command: `bun test`
- optional exact test arguments

Examples:
- `/pre-commit-checks`
- `/pre-commit-checks tests/unit/service.test.ts`
- `/pre-commit-checks tests/unit`

### Execution algorithm

```ts
1. normalize target command into exact `bun test ...`
2. compute workspaceStateFingerprint
3. compute runtimeFingerprint
4. compute commandFingerprint
5. load cache
6. if exact entry exists and not refresh:
     replay cached output
     return cached status
7. else:
     run `bun test ...`
     store full output in cache
     return fresh status
```

### Output shape

On cache hit, clearly say it is cached:

```text
pre-commit-checks: cache hit for current workspace state
command: bun test tests/unit/service.test.ts
recorded: 2026-04-09T...
status: failed
(replaying cached output below)
```

That explicitness matters for both humans and agents.

---

## `commit` procedure design

### Inputs

Likely:
- commit message
- optional `--refresh-checks`
- optional override for failed cached checks if explicitly allowed later

For v1, keep it strict:
- do not commit if the current exact cached/fresh `bun test` result is failing

### Execution algorithm

```ts
1. compute fingerprints for default pre-commit command (`bun test` by default)
2. look up cache entry
3. if cache hit and result failed:
     replay cached output
     stop and report failure
4. if cache hit and result passed:
     replay cached output
     continue to commit
5. if cache miss:
     run `pre-commit-checks`
     if failed, stop
     if passed, continue
6. create commit
```

### Why use cached failure too?

Because if workspace state is unchanged, rerunning the same `bun test` will almost certainly produce the same result.

The cache is being used as a deterministic memoization of:
- output
- exit code
- state identity

So failure replay is just as valuable as pass replay.

---

## Interaction with `scripts/compact-test.ts`

There are two implementation options.

### Option A — keep caching inside procedures only

- `pre-commit-checks` runs `bun test` directly and handles replay/cache itself
- `scripts/compact-test.ts` stays unchanged

Pros:
- narrower change
- easier to prove value

Cons:
- direct script invocations outside the procedures do not benefit

### Option B — add cache awareness to `scripts/compact-test.ts`

- procedures call the script
- script owns replay/cache logic
- standalone script use benefits too

Pros:
- one place for Bun test replay behavior
- reusable outside procedures

Cons:
- slightly larger initial change surface

### Recommendation

For v1, prefer **Option B** if the implementation stays small.

Reason:
- the repo already centralizes Bun test orchestration in `scripts/compact-test.ts`
- this behavior naturally belongs close to the existing compact test wrapper
- then `pre-commit-checks` can simply call the script and inherit replay behavior

But the fingerprint helpers should still live in `src/core/` so procedures and scripts share one implementation.

---

## Exact-match only for v1

Do **not** overengineer coverage reuse yet.

In v1, only reuse when all of these match exactly:
- `workspaceStateFingerprint`
- `runtimeFingerprint`
- `commandFingerprint`

That means:
- `bun test tests/unit` does **not** automatically satisfy `bun test tests/unit/service.test.ts`
- `bun test` does **not** automatically satisfy any narrower command

This keeps correctness simple and obvious.

Coverage/subsumption can come later if this proves effective.

---

## Data retention / cache pruning

Because the cache stores full output, it can grow.

For v1, use a simple policy:
- keep only the most recent N entries per `commandFingerprint`
- or cap total entries, e.g. 100
- replace older exact-match entries

Also:
- if a new run occurs for the same `(workspaceStateFingerprint, runtimeFingerprint, commandFingerprint)`, overwrite the prior record

That keeps the cache bounded and easy to reason about.

---

## Edge cases

### 1. No Git repo

If Git metadata is unavailable:
- either fail clearly for these procedures
- or fall back to a deterministic content walker later

For this repo-specific v1, it is acceptable to require Git.

### 2. Untracked files with weird sizes / binaries

We should hash deterministically, but for v1 it is okay to:
- skip obviously huge generated files
- exclude known generated dirs
- hash file contents for ordinary files only

### 3. Flaky tests

Cache replay is still correct for unchanged contents, but users may want a fresh rerun.

That is why `--refresh` / `force: true` matters.

### 4. Dependency changes

If `node_modules` changes without source changes, the cache would not notice unless runtime/config also changed.

For v1, that is acceptable if we scope this to typical local agent flows.

If needed later, we can incorporate lockfile hash into `workspaceStateFingerprint` or `checksFingerprint`.

---

## Suggested implementation phases

### Phase 1 — shared fingerprint helpers

1. add `src/core/workspace-state-fingerprint.ts`
2. compute:
   - `headCommit`
   - `stagedDiffHash`
   - `unstagedDiffHash`
   - `untrackedRelevantFilesHash`
   - `workspaceStateFingerprint`
3. add tests for deterministic behavior

### Phase 2 — cached Bun test result store

1. add repo-local cache reader/writer
2. add exact-match lookup by:
   - workspace state
   - runtime
   - command
3. store full output + exit code
4. add pruning policy

### Phase 3 — wire into compact-test

1. teach `scripts/compact-test.ts` to:
   - look up cache before running
   - replay cached output on exact match
   - store result after running
2. add a refresh flag
3. add tests for cache hit/miss behavior

### Phase 4 — add procedures

1. implement `pre-commit-checks`
2. implement `commit`
3. make `commit` depend on cached/fresh `pre-commit-checks`
4. keep v1 strict: block commit on failing cached/fresh result

---

## Tests to add

### Fingerprint helper

- same workspace state => same fingerprint
- staged change changes fingerprint
- unstaged change changes fingerprint
- untracked file changes fingerprint
- excluded dirs do not affect fingerprint

### Compact test cache

- exact same command + same state => cache hit
- changed workspace state => cache miss
- changed runtime => cache miss
- cached failure is replayed with nonzero exit code
- cached pass is replayed with zero exit code
- `--refresh` bypasses cache

### Procedures

- `pre-commit-checks` replays cached output on exact match
- `commit` blocks on cached failing result
- `commit` proceeds on cached passing result
- `commit` falls back to fresh `pre-commit-checks` when cache missing

---

## Acceptance criteria

1. We can compute a stable `workspaceStateFingerprint` for the current dirty repo state.
2. Re-running the same `bun test ...` command against unchanged contents replays cached output instead of rerunning.
3. Both passing and failing prior outputs are replayable.
4. `pre-commit-checks` uses this cache.
5. `commit` uses the same cache and shared fingerprint logic.
6. Changing staged, unstaged, or untracked relevant files invalidates the cached result.
7. The implementation remains narrow and Bun-specific for v1.

---

## Recommendation summary

For nanoboss v1, implement:

- one shared Git-aware `workspaceStateFingerprint`
- one cached exact-command `bun test` result store
- one `pre-commit-checks` procedure
- one `commit` procedure
- replay of the **full previous `bun test` output**, not just success state

This is narrow enough to avoid overengineering and directly targets the repeated test churn currently visible in this repo.
