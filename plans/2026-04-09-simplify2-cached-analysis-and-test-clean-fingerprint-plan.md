# Simplify2 cached analysis and test-clean fingerprint plan

Date: 2026-04-09

## Why this plan exists

The runtime postmortem for simplify2 showed two expensive patterns:

1. **simplify2 repeatedly re-researched the same seam** across iterations.
2. agents repeatedly reran tests for effectively the same repo contents before commit.

The concrete goals here are therefore:

- make simplify2 reuse prior analysis instead of starting fresh every iteration
- suppress near-duplicate hypotheses after an apply
- make validation command selection deterministic (`bun test`)
- introduce a repo-content fingerprint that can tag the repo as **test-clean for its current contents**

This plan also explores a side quest raised during the postmortem:

> We already have fingerprint-like concepts in nanoboss. Can we generalize that into a repo fingerprint and use it in the Bun test wrapper so agents stop rerunning the same passing suites for unchanged contents?

The answer is **yes**, with some care around scope, environment, and command coverage.

---

## Current findings

### Simplify2 today

`procedures/simplify2.ts` currently does this after each successful apply:

- `validateAndReconcile(...)`
- `resetNotebookForFreshAnalysis(...)`
- `analyzeCurrentFocus(...)`

And `analyzeCurrentFocus(...)` always does:

1. `refreshArchitectureMemory(...)`
2. `collectObservations(...)`
3. `generateAndRankHypotheses(...)`

So every iteration redoes the expensive research loop.

Important detail:
- `resetNotebookForFreshAnalysis(...)` clears `observations`, `candidateHypotheses`, `openQuestions`, and `refreshNotes`
- the durable repo-local artifacts today are only:
  - `.nanoboss/simplify2/architecture-memory.json`
  - `.nanoboss/simplify2/journal.json`
  - `.nanoboss/simplify2/test-map.json`

These are useful summaries, but they are too lossy to serve as a true reuse cache for the next iteration.

### Existing fingerprint precedent

Nanoboss already has a deterministic content fingerprint concept in:
- `src/core/workspace-identity.ts`

Specifically:
- `computeProceduresFingerprint(procedureRoots)`

That implementation:
- walks procedure roots deterministically
- sorts files
- hashes relative path + file contents
- returns a short SHA-256-derived digest

So the side quest does **not** require inventing a new pattern from scratch. We already use a content-addressed fingerprinting model for procedure compatibility.

### Compact test wrapper today

`scripts/compact-test.ts` currently:
- shards some test groups for performance
- runs `bun test --only-failures --reporter=junit ...`
- merges JUnit output
- has no concept of repo-content reuse

That means if the repo contents are unchanged, running the same command twice still executes the full test command twice.

---

## Design goals

### Simplify2 caching goals

1. Reuse prior repo analysis when the focus and relevant files have not materially changed.
2. Invalidate only the portions of analysis affected by touched files.
3. Re-rank from cached observations before doing another full repo scan.
4. Detect when the next hypothesis is just a reformulation of an already-applied seam.
5. Prefer checkpointing or finishing over another full research cycle in those cases.

### Test-clean fingerprint goals

1. Compute a deterministic fingerprint for the repo’s current contents.
2. Record when a specific test command passed against that exact fingerprint.
3. Let `scripts/compact-test.ts` short-circuit or annotate reruns when the command and repo contents are unchanged.
4. Preserve correctness by including enough environment identity in the cache key.
5. Avoid trusting stale passes when contents, runtime, command scope, or dependency state changed.

---

## Workstream A — cache simplify2 research and observations

### Recommendation

Yes: **cache the research and observations**, but not just as prose.

We should cache the **structured evidence bundle** that feeds hypothesis generation and ranking.

### New repo-local artifacts

Add these under `.nanoboss/simplify2/`:

1. `observations.json`
   - durable structured observations
   - cached evidence refs
   - source-path metadata for invalidation

2. `analysis-cache.json`
   - focus hash
   - repo fingerprint for the analysis scope
   - observation cache summary
   - latest touched files
   - stale/valid markers
   - optional overlap lineage for applied hypotheses

Optional later:

3. `hypothesis-cache.json`
   - last generated hypotheses
   - ranking results
   - overlap metadata

For the first pass, `observations.json` + `analysis-cache.json` is enough.

### Proposed artifact shapes

#### `observations.json`

```ts
interface Simplify2ObservationCache {
  version: 1;
  updatedAt: string;
  focusHash: string;
  analysisFingerprint: string;
  observations: Array<{
    observation: SimplifyObservation;
    sourcePaths: string[];
    evidenceRefs: SimplifyEvidenceRef[];
    derivedFromArtifacts: string[];
    stale: boolean;
  }>;
}
```

#### `analysis-cache.json`

```ts
interface Simplify2AnalysisCache {
  version: 1;
  updatedAt: string;
  focusHash: string;
  analysisFingerprint: string;
  lastAppliedHypothesisId?: string;
  lastTouchedFiles: string[];
  reusableObservationIds: string[];
  staleObservationIds: string[];
  overlapSuppression: Array<{
    hypothesisId: string;
    normalizedScopeTokens: string[];
    touchedFiles: string[];
    summaryFingerprint: string;
  }>;
}
```

### State additions in `procedures/simplify2.ts`

Add artifact paths:

```ts
artifacts: {
  ...
  observationsPath?: string;
  analysisCachePath?: string;
}
```

Add working state:

```ts
analysisCache: {
  focusHash: string;
  analysisFingerprint?: string;
  observationsLoaded: boolean;
  reusedObservationIds: string[];
  staleObservationIds: string[];
}
```

### Fingerprints for simplify2 analysis

We should distinguish between:

- **focus hash**
  - derived from the normalized simplify2 prompt + constraints/guidance/scope/exclusions

- **analysis fingerprint**
  - derived from the repo contents relevant to the current analysis

The first implementation can keep this simple:
- analysis fingerprint = repo fingerprint of files that observations cite, or if that set is empty, the repo fingerprint of the whole repo minus excluded directories

That gives us stable invalidation without solving perfect minimal dependency tracking up front.

### Execution changes

#### Current flow

```ts
resetNotebookForFreshAnalysis()
analyzeCurrentFocus()
```

#### Planned flow

```ts
resetNotebookForFreshAnalysis({ preserveReusableObservations: true })
rehydrateCachedAnalysis()
refreshOnlyStaleOrTouchedAreas()
regenerateAndRankFromMergedObservationSet()
```

### Detailed behavior

#### 1. First iteration

- load or initialize caches
- run full architecture refresh + full observation collection
- persist structured observations and source paths
- persist analysis fingerprint

#### 2. After apply

Use:
- `state.notebook.latestApply.result.touchedFiles`

Then:
- mark cached observations stale if their `sourcePaths` intersect touched files
- preserve unaffected observations
- rerun architecture refresh only if touched files hit high-sensitivity files
  - e.g. `src/core/service.ts`, `src/core/memory-cards.ts`, `src/mcp/server.ts`, `src/session/**`
- rerun observation collection only for touched files + nearby tests/docs
- merge new observations with preserved ones
- regenerate/rank hypotheses from the merged set

#### 3. Full refresh fallback

Do a full refresh only when:
- focus text changed materially
- changed file coverage is too broad
- more than N% of cached observations are stale
- the apply touched foundational files that invalidate global reasoning

A reasonable first threshold:
- full refresh if stale observations > 40% of reusable observation cache

### Hypothesis overlap suppression

This is the second major simplify2 fix.

The postmortem showed:
- H3
- H1
- H4

were effectively repeated passes on the same seam.

#### Add an overlap score

Compute overlap using:
- title token similarity
- summary token similarity
- implementation scope overlap
- touched-file overlap with prior applied hypotheses
- evidence ref overlap

Example scoring:

```ts
overlap =
  0.35 * titleSimilarity +
  0.25 * summarySimilarity +
  0.25 * scopeOverlap +
  0.15 * touchedFileOverlap;
```

#### Policy

If a candidate hypothesis has:
- high overlap with an already-applied hypothesis
- and no clearly new file set or conceptual delta

then do one of:
- downgrade score heavily
- fold it into the previous hypothesis lineage
- pause for human approval immediately
- or finish with “no clearly distinct next slice”

Recommended first policy:
- if overlap >= 0.75 and risk is not low, checkpoint immediately
- if overlap >= 0.85 and new touched-file set is empty, treat as duplicate and suppress

### Validation policy fixes

#### Force Bun

Although `runSelectedValidation(...)` already uses Bun, the apply subagent in the postmortem still drifted to `npm test` during its own local iteration logic.

So tighten the apply prompt to say:
- validation commands must use `bun test`, never `npm test`
- if the agent proposes a command in `validationNotes`, it must match the actual Bun invocation

#### Add retry budget

Current problem:
- one apply phase spent ~10 minutes rerunning the same suite

Plan:
- track repeated validation command + repo fingerprint pairs during one apply attempt
- cap retries per identical command/fingerprint pair

Recommended first budget:
- max 2 reruns after the first failure for the exact same validation command and same repo fingerprint
- after that, pause or fail the iteration with a compact diagnosis

### Acceptance criteria for Workstream A

1. Second simplify2 iteration on a narrow seam does **not** always perform a full repo-wide observation pass.
2. Cached observations survive `resetNotebookForFreshAnalysis(...)` unless invalidated.
3. Touching one of 4 files does not force rereading dozens of unrelated files.
4. Near-duplicate follow-up hypotheses are suppressed or checkpointed.
5. Apply subagents no longer drift to `npm test` in validation guidance.
6. Repeated validation failures are capped before burning many more minutes.

---

## Workstream B — repo fingerprint and test-clean tagging

## Core idea

Introduce a deterministic fingerprint for the repo’s current contents and let the test wrapper remember:

> “Command X passed for repo fingerprint Y under environment Z.”

Then if an agent runs the exact same test command again without changing repo contents, we can say:
- already validated for current contents
- skip rerun, or
- downgrade to a fast no-op confirmation mode

### How should `repoFingerprint` be computed?

There are two viable designs.

#### Option 1 — Git tree based

Fingerprint from:
- HEAD commit
- staged diff
- unstaged diff
- untracked files

Pros:
- fast when Git is available
- aligned with tracked source state

Cons:
- harder to include untracked-but-relevant files correctly
- not ideal if we want “entire repo contents” independent of Git state
- can be awkward with ignored generated files

#### Option 2 — deterministic content walker

Fingerprint from:
- sorted relative file paths
- file contents
- explicit exclusion rules

This mirrors `computeProceduresFingerprint(...)` and is the better fit here.

Pros:
- git-independent
- deterministic
- works on dirty worktrees and untracked files
- conceptually matches existing nanoboss fingerprinting

Cons:
- potentially slower for very large repos
- needs a well-defined exclusion policy

### Recommendation

Use **Option 2** for the first implementation.

Specifically:
- walk the repo root deterministically
- hash `relativePath + '\n' + fileContents + '\n'`
- exclude directories/files that should never affect source-test validity

### Proposed exclusions

Exclude by default:
- `.git/`
- `node_modules/`
- `.nanoboss/`
- `dist/`
- `coverage/`
- temporary test output directories
- OS junk files

Possibly configurable later.

### Proposed API

Add:

```ts
interface RepoFingerprintOptions {
  cwd: string;
  include?: string[];
  exclude?: string[];
}

function computeRepoFingerprint(options: RepoFingerprintOptions): {
  repoRoot: string;
  fingerprint: string;
  fileCount: number;
};
```

Suggested location:
- `src/core/repo-fingerprint.ts`

This should deliberately resemble `computeProceduresFingerprint(...)`.

### Environment fingerprint

A test-clean tag should not depend on repo contents alone.

A passing result also depends on:
- Bun version
- OS / platform
- relevant env knobs
- test command itself

So define:

```ts
interface TestCleanKey {
  repoFingerprint: string;
  commandFingerprint: string;
  runtimeFingerprint: string;
}
```

Where:
- `commandFingerprint` hashes the normalized test command and selected test args
- `runtimeFingerprint` hashes:
  - `Bun.version`
  - platform + arch
  - maybe selected env vars like `NANOBOSS_RUN_E2E`

### Test-clean cache format

Store in a git-ignored repo-local file:
- `.nanoboss/test-clean.json`

Suggested shape:

```ts
interface TestCleanCache {
  version: 1;
  updatedAt: string;
  entries: Array<{
    repoFingerprint: string;
    commandFingerprint: string;
    runtimeFingerprint: string;
    command: string;
    selectedTests: string[];
    status: "passed" | "failed";
    passedAt?: string;
    durationMs?: number;
  }>;
}
```

We only reuse entries with:
- `status === 'passed'`
- exact repo fingerprint match
- exact command fingerprint match
- exact runtime fingerprint match

### How `scripts/compact-test.ts` should use it

#### Before running

1. normalize the requested command
2. compute repo fingerprint
3. compute runtime fingerprint
4. look up a passing cache entry

If found:
- print a compact message such as:
  - `test-clean cache hit: bun test tests/unit/service.test.ts for repo abc123def456`
- optionally emit the cached summary
- exit 0 without rerunning

#### After running

- on pass: record/replace the cache entry
- on fail: update cache with failed status or delete prior passing entry for that key

### Coverage semantics

There are two levels of reuse.

#### Phase 1 — exact command reuse only

Safe and easy:
- only skip when the exact same normalized command already passed for the current repo fingerprint

#### Phase 2 — coverage reuse / subsumption

More powerful:
- if `bun test tests/unit` passed, then `bun test tests/unit/service.test.ts` is implicitly covered
- or if `bun test tests/unit/service.test.ts tests/unit/memory-cards.test.ts` passed, those individual file commands are covered

This is valuable, but it adds complexity.

Recommendation:
- implement **exact reuse first**
- add subsumption later if it proves worth the complexity

### Can this save the agent’s repeated pre-commit reruns?

Yes, especially for this pattern:
- agent runs focused tests
- agent reruns same focused tests after reading diffs but before commit
- repo contents have not changed between those runs

It will save **a lot** of redundant passes in exactly that case.

It will not help when:
- repo contents actually changed
- the command differs
- runtime/env differs

But that still covers a large class of current agent churn.

### Caveats

1. This is a **local correctness cache**, not a proof that all desired tests ran.
2. It should never silently expand one passing command into broader semantic claims unless we implement explicit coverage/subsumption rules.
3. Ignored/generated files must be excluded carefully so the fingerprint represents meaningful source state.
4. The cache must be invalidated by Bun/runtime changes.

### Acceptance criteria for Workstream B

1. We can compute a stable repo fingerprint for the current repo contents.
2. `scripts/compact-test.ts` records successful passes keyed by repo+command+runtime fingerprints.
3. Repeating the exact same `bun test ...` command without content changes yields a cache hit and no rerun.
4. Changing any repo file invalidates the cache key.
5. Changing Bun version invalidates the cache key.
6. The cache lives in a repo-local ignored location and does not pollute tracked source state.

---

## Suggested implementation phases

### Phase 1 — low-risk wins

1. Add `src/core/repo-fingerprint.ts`
2. Add `.nanoboss/test-clean.json` support to `scripts/compact-test.ts`
3. Implement exact command reuse only
4. Add simplify2 overlap suppression
5. Tighten simplify2 apply prompt to require Bun validation commands
6. Add retry cap for repeated same-command validation failures

### Phase 2 — cached simplify2 analysis

1. Add `observations.json` and `analysis-cache.json`
2. Preserve/reuse observations across iterations
3. Invalidate by touched files
4. Add targeted refresh fallback
5. Add tests proving second iteration avoids a full repo reread for narrow edits

### Phase 3 — smarter reuse

1. Add optional hypothesis-cache reuse
2. Add command-coverage/subsumption for test-clean tags
3. Add selective high-sensitivity invalidation rules for simplify2 architecture refresh

---

## Tests to add

### Simplify2 caching

- unit test: cached observations survive `resetNotebookForFreshAnalysis(...)`
- unit test: touched-file invalidation marks only overlapping observations stale
- unit test: overlap suppression demotes near-duplicate hypotheses
- unit test: apply validation retry cap triggers after repeated same-command failures
- unit test: apply prompt explicitly prefers `bun test`

### Repo fingerprint / test-clean tagging

- unit test: repo fingerprint stable for unchanged contents
- unit test: changing one file changes fingerprint
- unit test: excluded dirs do not affect fingerprint
- unit test: compact-test cache hit skips exact rerun
- unit test: runtime fingerprint change invalidates cache
- unit test: failed run does not produce a reusable passing tag

---

## Open questions

1. Should simplify2 cache only observations, or also cache a normalized “evidence bundle” below observations for even finer invalidation?
2. Should repo fingerprint include ignored files under some allowlist, or should ignored always mean excluded?
3. Should test-clean cache be purely exact-command reuse, or do we want subset/superset coverage soon after phase 1?
4. For simplify2, should repeated same-seam follow-ups finish automatically, or always checkpoint for confirmation?
5. Should the repo fingerprint helper be reused by other nanoboss workflows beyond testing and simplify2?

---

## Recommendation summary

Yes — the concrete recommendation is:

- **cache the research and observations** in structured form
- **invalidate by touched files instead of resetting everything**
- **re-rank from cached observations before doing a new full scan**
- **suppress near-duplicate hypotheses**
- **introduce a repo-content fingerprint** modeled after `computeProceduresFingerprint(...)`
- **use that fingerprint in `scripts/compact-test.ts`** to mark the repo as test-clean for an exact command/runtime/content tuple

That combination should directly attack both runtime problems seen in the postmortem:
- simplify2’s repeated research passes
- agents’ repeated no-op test reruns before commit
