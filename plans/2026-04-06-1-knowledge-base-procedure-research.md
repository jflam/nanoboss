# 2026-04-06 knowledge-base procedure research

## Summary

Yes: nanoboss is a strong fit for a Karpathy-style "LLM knowledge base" workflow, but only if the workflow is framed as a **deterministic, durable compilation pipeline** instead of a loose pile of prompts.

That distinction is the real product story:

- **raw inputs** should be immutable or content-addressed,
- a repo-level **schema file** should define structure and workflow conventions,
- **procedures** should own the state transitions,
- **agents** should supply interpretation inside bounded steps,
- **cells/refs/files** should be the durable provenance layer,
- and **reruns** should converge instead of drifting.

Without that structure, the workflow quickly becomes an opaque set of one-off agent calls. With it, nanoboss can show something much stronger: a knowledge system where every derived wiki page, QA artifact, lint finding, and visualization is reproducible, inspectable, resumable, and attributable to a specific procedure run.

Original inspiration:

- Andrej Karpathy, "LLM Knowledge Bases" (X/Twitter, 2026-04-04): <https://x.com/karpathy/status/2039805659525644595>

---

## Files inspected

- `commands/research.ts`
- `commands/linter.ts`
- `commands/second-opinion.ts`
- `commands/default.ts`
- `src/core/context.ts`
- `src/core/types.ts`
- `src/session/store.ts`
- `src/procedure/runner.ts`
- `src/procedure/registry.ts`
- `src/procedure/dispatch-jobs.ts`
- `src/procedure/dispatch-progress.ts`
- `src/mcp/session-tool-procedures.ts`
- `docs/architecture.md`

---

## Why

The Karpathy workflow has six repeating stages:

1. ingest raw material
2. normalize or summarize it
3. compile/update wiki pages
4. answer questions against the compiled corpus
5. render derivative artifacts
6. run health checks and repair passes

Nanoboss already has the right primitives for all six:

- **typed agent outputs** via `ctx.callAgent(..., ResultType)` let procedures demand structured intermediate results instead of free-form prose
- **procedure composition** via `ctx.callProcedure(...)` supports multi-step pipelines instead of giant monolithic prompts
- **durable cells and refs** in `SessionStore` provide exact, inspectable provenance for every run
- **display vs data separation** lets a procedure keep machine state small while still producing human-readable markdown
- **async dispatch jobs** support long-running compilation/lint passes without relying on one fragile long-lived request
- **session inspection procedures** (`top_level_runs`, `cell_get`, `cell_descendants`, `ref_read`, `get_schema`) already make prior work queryable

So the answer is not merely "yes, procedures could automate this." The stronger answer is:

**nanoboss procedures are a better fit than ad hoc prompting because the workflow is inherently iterative, file-producing, and stateful.**

This matters because a personal research wiki stops being "just chat" very quickly:

- the corpus changes over time
- new sources arrive incrementally
- old summaries go stale
- concept pages must be refreshed, not rewritten blindly
- answers should cite or point back to the exact source pages they depend on
- lint/repair passes must distinguish new work from already-processed work

That is exactly where deterministic procedures start to matter.

### Why determinism is essential here

In this workflow, determinism is not a nice-to-have polish feature. It is what keeps the system from collapsing into unrecoverable prompt soup.

The core reliability problems are:

1. **incremental ingest** — the system must know what is new, what changed, and what can be skipped
2. **repeatable compilation** — rerunning "compile wiki" should update the same conceptual targets, not invent a different structure every time
3. **resumability** — long runs need to survive interruptions and continue from durable state
4. **provenance** — a generated note or answer should be traceable to exact upstream summaries and sources
5. **repairability** — lint and health-check procedures must operate against known artifacts, not against a drifting conversational memory

Nanoboss's procedure abstraction is useful here precisely because it creates a host-side state machine around the agent:

- procedure code chooses the step order
- procedure code decides what gets persisted
- procedure code decides what counts as completion
- procedure code can re-read prior refs instead of trusting the agent to remember them

For a knowledge-base product, that is the difference between:

- **"ask the model to manage my wiki"**

and

- **"use the model inside a deterministic compiler for my wiki."**

The second framing is much more compelling, and much more aligned with nanoboss.

---

## Approach

The most convincing design is not one giant `/wiki` procedure. It is a small, composable procedure family with explicit boundaries between phases.

Just as importantly, the repo should have an explicit control-plane document (for example `CLAUDE.md` or `AGENTS.md`) that tells the agent:

- the semantic layout of the knowledge base
- which files are authoritative
- how ingest/query/lint flows should behave
- how citations, links, and logs should be maintained

That schema file is not just documentation. It is part of the product surface: the thing that turns a generic coding agent into a disciplined wiki maintainer.

### Proposed procedure set

#### 1. `/kb-ingest`

Purpose: register new raw inputs into the corpus.

Expected responsibilities:

- scan `raw/` for new or changed items
- assign stable source ids
- capture content hashes / timestamps / source metadata
- write a deterministic manifest for downstream procedures
- default to one-source-at-a-time ingest, with batching as an explicit later mode
- return refs to the manifest entries, not huge blobs

Why it matters:

- gives the whole system a stable unit of work
- makes later procedures idempotent
- lets the user add files freely while procedures own indexing state

#### 2. `/kb-compile-source`

Purpose: turn one raw source into normalized structured knowledge.

Expected responsibilities:

- classify source type (paper, repo, article, dataset, image set, notes)
- extract metadata
- produce a short typed summary plus claims/questions/tags/backlink candidates
- write a source summary markdown page and a small machine-readable result

Why it matters:

- isolates the noisiest agent step
- creates a deterministic per-source artifact that later synthesis can depend on
- makes retries cheap and localized

#### 3. `/kb-compile-concepts`

Purpose: synthesize concept pages from source summaries.

Expected responsibilities:

- read existing source-summary refs
- cluster or route them into concept/article targets
- update specific concept pages instead of free-form repo-wide rewriting
- emit a compact record of which concept pages were touched and why

Why it matters:

- this is the heart of the "compiled wiki" idea
- it forces the agent to operate against stable upstream summaries, not raw sprawl
- it turns concept synthesis into a rerunnable compilation step

#### 4. `/kb-link`

Purpose: rebuild deterministic structural glue.

Expected responsibilities:

- refresh `wiki/index.md` or equivalent content index
- ensure newly created or updated pages are represented with short descriptions and stable links
- refresh backlinks / related-pages sections
- rebuild topic maps or category pages
- detect orphans and duplicate concepts

Why it matters:

- structural consistency is where wikis usually drift
- the index file gives both humans and agents a stable entrypoint into the corpus
- a dedicated linking pass makes the corpus feel maintained instead of accreted

#### 5. `/kb-answer`

Purpose: answer a research question against the compiled corpus.

Expected responsibilities:

- plan the query against source summaries and concept pages
- read `wiki/index.md` first as the default discovery surface, then drill into candidate pages
- gather exact refs used in the answer
- write the answer to `outputs/` or another chosen destination
- optionally file durable, high-value answers back into the wiki as new analysis pages
- keep `data` small and provenance-heavy

Why it matters:

- shows off nanoboss as a durable research assistant, not just a compiler
- demonstrates that answers are derived from stored artifacts, not ephemeral model memory

This should probably be closer to `commands/research.ts` than to `/default`: produce a markdown artifact and a compact summary, not just terminal text.

#### 6. `/kb-render`

Purpose: turn stored results into presentation artifacts.

Expected responsibilities:

- render markdown reports
- render Marp decks
- render simple plots or diagrams
- file outputs back into the corpus when appropriate

Why it matters:

- completes the loop Karpathy described: outputs become part of the knowledge base
- showcases that nanoboss procedures can write durable artifacts, not just speak

#### 7. `/kb-health`

Purpose: run consistency checks and create repair work.

Expected responsibilities:

- find missing metadata
- find uncited or weakly sourced claims
- find unlinked pages, stale pages, broken references, or inconsistent naming
- suggest or create deterministic repair queues

Why it matters:

- this is a natural fit for the existing "discover -> act -> re-check" style used by `commands/linter.ts`
- it turns maintenance into a first-class workflow instead of ad hoc cleanup

#### 8. `/kb-refresh`

Purpose: orchestrate the whole incremental pipeline.

Expected responsibilities:

- call `/kb-ingest`
- fan out `/kb-compile-source` for changed items
- call `/kb-compile-concepts`
- call `/kb-link`
- optionally call `/kb-health`
- append a deterministic entry to `wiki/log.md` or equivalent chronology
- report exactly what changed

Why it matters:

- this is the user-facing "one command" entrypoint
- but it remains reliable because it composes deterministic subprocedures rather than hiding everything in one prompt

### Recommended directory and artifact model

To match the intended workflow, the cleanest shape is roughly:

```text
CLAUDE.md or AGENTS.md
raw/
wiki/
  index.md
  log.md
  sources/
  concepts/
  indexes/
derived/
  reports/
  slides/
  images/
.kb/
  manifests/
  queues/
  state/
```

The exact names are not important. The important thing is that procedures write to **distinct semantic layers**:

- raw inputs
- schema / workflow conventions
- compiled knowledge
- derived outputs
- deterministic bookkeeping

That bookkeeping layer is where determinism becomes real.

### Two human-facing control files should be explicit

The longer-form Karpathy writeup adds two files that are worth treating as first-class artifacts instead of incidental outputs:

1. **`index.md`** — a content-oriented catalog that helps both the user and the agent discover what already exists before deciding what to read or update.
2. **`log.md`** — an append-only chronological record of ingests, answers, and health checks that makes recent activity and evolution legible.

These should not replace `.kb/` bookkeeping. They complement it:

- `.kb/` is machine-oriented state for deterministic orchestration
- `index.md` and `log.md` are human/agent-readable navigation surfaces inside the wiki itself

That split feels well aligned with nanoboss's "small typed data, rich markdown display" model.

### Index-first retrieval is a real design point, not just documentation

The gist adds a useful operational detail: at moderate scale, `index.md` is not merely a table of contents. It can be the **default retrieval surface** for question-answering:

- read `index.md` first to identify candidate pages
- drill into those pages for synthesis
- avoid introducing embedding-heavy RAG infrastructure too early

That is worth preserving in the design because it suggests a concrete staged strategy:

1. start with deterministic wiki files plus `index.md`
2. use file-based retrieval against the compiled corpus
3. add specialized search only when scale demands it

This is especially aligned with nanoboss because the early version can stay simple, inspectable, and local.

### Optional search tooling belongs in the "later scale" story

The gist also usefully calls out that a wiki-local search layer may become desirable once the corpus grows past what `index.md` alone can comfortably support.

That suggests an explicit non-goal / later-phase note for implementation:

- **initial design:** no mandatory vector database or external RAG stack
- **later option:** add local markdown search tooling (for example qmd-style BM25/vector/rerank search) behind a procedure or tool boundary

That keeps the thin slice simpler while still leaving a path to better retrieval once the corpus is large.

### Multimodal sources need an explicit asset-handling convention

One genuinely new operational point from the gist is that web-clipped sources may include images that should be downloaded into the repo if they matter.

That is relevant here because the proposed source types already include image sets. The schema/config should therefore be able to specify:

- where source-linked assets live (for example `raw/assets/`)
- whether image downloads are required, optional, or ignored
- whether source compilation may involve a two-pass read: text first, then selected images

This should stay optional, but it is worth naming so the design does not silently assume all sources are text-only.

---

## Why nanoboss specifically can show this off well

This workflow is a particularly good demo for nanoboss because it highlights things plain chat agents do poorly:

### 1. Durable session provenance

Nanoboss can retain:

- top-level runs
- nested procedure calls
- agent calls
- exact refs to outputs

That means a generated concept page can be tied back to:

- the top-level refresh run,
- the source-compilation procedure that fed it,
- and the exact machine result or markdown artifact produced at each step.

For a knowledge base, that is a major trust and debugging advantage.

### 2. Deterministic host-side orchestration

The procedure, not the model, decides:

- which files are in scope
- which previous refs are authoritative
- which outputs must exist before the next step can run
- whether a rerun should skip, update, or fail

That is much more convincing than hoping the model maintains its own internal plan.

### 3. Typed intermediate state

Because procedures can demand structured JSON outputs, the system can store things like:

- source metadata
- claim lists
- citation lists
- concept targets
- lint findings
- output manifests

as explicit machine state instead of scraping markdown after the fact.

### 4. Async long-running jobs

Large wiki refreshes are naturally long-running. Nanoboss already has an async dispatch path and progress bridge, which makes a corpus-refresh story much more believable than a single blocking command.

### 5. Inspection as a first-class capability

The existing session inspection procedures and MCP tools are a surprisingly strong fit for this product idea. They make it possible to ask not only:

- "what is in the wiki?"

but also:

- "which run created this file?"
- "which source summaries fed this answer?"
- "what changed in the last refresh?"
- "which procedure is currently blocked or still running?"

That is a compelling differentiator.

---

## Determinism requirements for a real implementation

If this moves from exploration to implementation, the procedure family should explicitly adopt a few invariants.

### 1. Stable units of work

Every raw source should have a stable identity derived from deterministic metadata, ideally including a content hash.

That identity should drive:

- filenames
- manifests
- refresh decisions
- repair queues

### 2. Idempotent writes

Procedures should target known output paths and update them intentionally.

Avoid "write a new article somewhere sensible" behavior. Prefer:

- source `abc123` always maps to `wiki/sources/abc123.md`
- concept `transformers` always maps to `wiki/concepts/transformers.md`

### 3. Typed handoffs between phases

Do not make downstream phases parse previous markdown when a typed result can carry the important machine state.

Markdown is for humans.
Typed `data` and durable refs are for orchestration.

### 4. Explicit freshness rules

Each procedure should be able to explain why an artifact is:

- fresh,
- stale,
- missing,
- or needing recomputation.

This is essential for incremental refresh and trustworthy health checks.

### 5. Resume from durable state, not conversational memory

Long-running refreshes should be restartable from manifests, files, and stored refs.

If a process dies halfway through compiling 100 sources, the right behavior is:

- discover completed work,
- discover pending work,
- continue deterministically.

### 6. Preserve provenance in `data`

Procedure `display` can stay user-friendly, but `data` should preserve the graph:

- source ids
- touched pages
- upstream refs
- downstream output refs
- counts / statuses / error locations

That is what enables later procedures like `/kb-answer` and `/kb-health` to stay grounded.

### 7. Keep the schema file explicit and durable

The repo should contain a durable schema/config file (`CLAUDE.md`, `AGENTS.md`, or equivalent) that documents:

- page classes and naming conventions
- where raw, compiled, and derived artifacts live
- expected ingest/query/lint workflows
- citation and logging conventions

This gives the agent a stable operating contract across sessions and makes the workflow easier to co-evolve over time.

---

## Suggested implementation stance

If this becomes real work, I would strongly recommend positioning it as:

**a deterministic knowledge compiler built from nanoboss procedures**

not as:

**a general chat agent that happens to write markdown files.**

That positioning makes the best use of nanoboss's architecture.

The first thin slice should probably be:

1. `/kb-ingest`
2. `/kb-compile-source`
3. `/kb-refresh`
4. `/kb-answer`

That is enough to prove the loop:

- add raw files
- compile durable summaries
- maintain a schema file plus `index.md` / `log.md`
- answer against them
- write results back out

Within that thin slice, the default operator experience should be supervised per-source ingest first, with larger batch modes added only after the artifact model is stable.

Then add concept synthesis, linking, rendering, and health checks once the deterministic artifact model is solid.

---

## Resolved implementation decisions

1. **Deterministic bookkeeping lives in the repo under `.kb/`.**  
   This is now the chosen direction. The knowledge repo should carry its own compiler state instead of depending on session state alone.

2. **Repo files hold durable domain artifacts; nanoboss session cells hold provenance and machine handoff refs.**  
   This split is now explicit and should guide command design.

3. **Source compilation should be per-item first, with batching as a later optimization layer.**  
   This keeps the initial implementation more deterministic and more resumable.

4. **Concept pages should use stable targets rather than free-form reorganization.**  
   Stability is important for users, so concept-page identity should be preserved across refreshes.

5. **Citations should have both markdown rendering and a typed intermediate representation.**  
   That dual representation is the selected direction for future health checks and structured provenance.

6. **A repo-level schema file (`CLAUDE.md`, `AGENTS.md`, or equivalent) should be treated as a first-class artifact.**  
   It should define wiki structure, naming, workflows, and maintenance conventions so procedures and agents share the same operating contract.

7. **`wiki/index.md` and `wiki/log.md` should be explicit maintained outputs.**  
   The index is the content-oriented entrypoint for discovery; the log is the chronological record of ingests, answers, and maintenance.

8. **The default ingest UX should be supervised and per-source.**  
   Human-in-the-loop ingest is the best initial posture; high-throughput batching should be additive, not foundational.

9. **`wiki/index.md` should double as the default retrieval surface until corpus scale justifies a dedicated search layer.**  
   Early query behavior should prefer deterministic file navigation over adding RAG infrastructure prematurely.

10. **A later search layer should be optional and local-first.**  
    If the corpus outgrows `index.md`, add markdown-native search behind a clean boundary instead of making retrieval infrastructure foundational from day one.

11. **Image and other source-linked assets should have an explicit repo convention when multimodal ingest matters.**  
    Asset location and read workflow should be defined by schema, not improvised per session.

---

## Bottom line

The workflow is very achievable in nanoboss, and it could be a strong showcase.

But the showcase should not be "look, nanoboss can run a big research prompt."

It should be:

**look, nanoboss can run a deterministic, inspectable, resumable knowledge-compilation pipeline where LLMs do the semantic work and procedures keep the whole system reliable.**
