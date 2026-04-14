# Nanoboss Nouns And Verbs Inventory

Scope: this inventories the conceptual nouns and actions that define nanoboss behavior, plus the package-level workflow objects that materially shape runtime behavior. It intentionally excludes one-off private helper structs that do not create an enduring concept in the system.

Primary evidence: `src/core/types.ts`, `src/core/service.ts`, `src/session/store.ts`, `src/session/repository.ts`, `src/runtime/service.ts`, `src/mcp/server.ts`, `src/procedure/registry.ts`, `src/procedure/runner.ts`, `src/procedure/dispatch-jobs.ts`, `src/agent/default-session.ts`, `src/agent/acp-runtime.ts`, `src/http/frontend-events.ts`, `src/tui/commands.ts`, and `procedures/**`.

## Nouns

### Core Runtime And Durable State

| Noun | Kind | Intended purpose | Why does this exist | Suspected duplicate / overlap |
| --- | --- | --- | --- | --- |
| `Session` | Runtime boundary | The top-level unit a user talks to; owns cwd binding, default agent state, event stream, and durable history. | Nanoboss needs one stable handle that ties UI state, downstream agent continuity, and durable storage together. | Overlaps with `SessionMetadata`, the live in-memory `SessionState`, and the current-session index. |
| `SessionMetadata` | Durable record | `session.json` header for one session: cwd, rootDir, timestamps, default agent selection, pending continuation, persisted ACP session id. | Resume has to work after process exit without reloading every cell first. | Overlaps with live `SessionState` and `current-sessions.json`; three views of one session identity. |
| `current-sessions.json` workspace index | Durable cache | Maps workspace identity to the current session snapshot. | Lets runtime and MCP resolve "current session for this cwd" cheaply. | Duplicates data already present in `session.json`; it is a workspace-local index over canonical session metadata. |
| `SessionStore` | Data store | Canonical durable storage for cells, refs, and prompt attachments under one session root. | Nanoboss needs a transport-neutral store that survives CLI, HTTP, and MCP access patterns. | Live UI history also exists in `SessionEventLog`; both track runs, but `SessionStore` is the authority. |
| `Cell` | Durable unit | Atomic stored unit for a top-level procedure run, nested procedure call, or downstream agent call. | One tree structure simplifies history, introspection, refs, and async recovery. | "Run" and "cell" are near-synonyms in user-facing language. |
| `CellKind` | Classifier | Distinguishes `top_level`, `procedure`, and `agent` cells. | Needed for traversal, filtering, and to preserve the execution tree. | Slight conceptual overlap with procedure execution mode, but one classifies storage nodes and the other classifies routing. |
| `CellRecord` | Full stored object | Exact persisted cell payload including input, output, and metadata. | Needed for authoritative replay, MCP reads, and recovery. | Overlaps with `CellSummary`, `RunResult`, and `ProcedureExecutionResult`, which are thinner projections of the same run. |
| `CellSummary` | Lightweight projection | Cheap summary view used by recent/top-level/ancestor/descendant queries. | Listing should not require reading and returning full cell payloads every time. | Strong overlap with `CellRecord`; this is the query projection. |
| `CellRef` | Durable pointer | Stable `(sessionId, cellId)` reference to one cell. | Lets procedures and MCP refer to prior results without copying them. | Parent of `ValueRef`; often paired with `ValueRef` in APIs. |
| `ValueRef` | Durable pointer | Stable reference to a path within a stored cell. | Keeps structured results ref-heavy and avoids copying large data blobs into prompts or tool outputs. | Overlaps with raw embedded data and with `dataRef`/`displayRef` fields on result objects. |
| `RefStat` | Metadata view | Lightweight description of a ref value: type, size, preview. | A caller often needs to inspect a ref before fully reading it. | Overlaps with `get_schema`; both are "peek before read" surfaces but with different emphases. |
| `ProcedureResult` | Author return shape | What a procedure returns before nanoboss persists it. | Gives procedure authors a small, consistent output contract. | Overlaps with `RunResult` and `ProcedureExecutionResult`; this is the earliest layer. |
| `RunResult` | Finalized call result | The post-persistence return object for nested procedure or agent calls. | Callers need refs to stored outputs, not just raw strings. | Overlaps with `ProcedureExecutionResult`; `RunResult` is the nested-call API shape. |
| `ProcedureExecutionResult` | Top-level execution result | Public result for a completed top-level procedure run. | Service, dispatch, and MCP need a richer top-level return with refs, summary, token usage, and selection changes. | Another projection of the same cell data. |
| `ProcedurePause` | Pause payload | Question, resumable state, suggested replies, and optional continuation UI. | Enables multi-turn procedures without leaking transient state into the frontend only. | Overlaps with `PendingProcedureContinuation`; that type is the session-bound wrapper around this payload. |
| `PendingProcedureContinuation` | Session-bound pause | Stored active continuation bound to a procedure and owning cell. | Plain-text user replies need a deterministic place to go after a procedure pauses. | Mostly `ProcedurePause` plus routing information; likely intentionally layered but conceptually duplicate. |
| `ProcedureContinuationUi` | Structured continuation affordance | UI-level actions for complex pauses such as simplify2 checkpoints and focus picking. | Free-text replies are weak for rich pause states; frontends need structure. | Overlaps with suggested replies; this is the richer version. |
| `PromptInput` / `ProcedurePromptInput` / `PromptPart` / image summaries | Prompt envelope | Normalized multimodal input and its plain-text/display projections. | Nanoboss needs to preserve both transport-safe structure and user-facing text. | Several representations of the same prompt at different stages. |
| `Procedure` / `ProcedureMetadata` / `DeferredProcedureMetadata` | Command abstraction | Declares name, description, input hint, routing mode, execute, and optional resume. | This is the core extension model of nanoboss. | Overlaps with "command" as a user term; not every command is a procedure. |
| `ProcedureRegistry` | Registry / loader | Holds built-ins, lazily loaded disk procedures, and `/create` output. | Commands must be discoverable, loadable, and persistable across sources. | Overlaps with MCP `procedure_list` / `procedure_get`, which are public projections of the same registry. |
| `ProcedureExecutionMode` | Routing hint | Marks procedures as `defaultConversation` or `harness`. | Service routing needs a declared execution intent. | Overlaps with the command-surface taxonomy in `plans/2026-04-07-command-surface-formalization-plan.md`; current code only captures part of the taxonomy. |
| `CommandContextImpl` / `ProcedureApi` | Execution context | The capabilities exposed to a running procedure: agent, state, session, UI, nested procedures, cwd, cancellation. | Procedures need a constrained, testable surface instead of arbitrary service access. | Conceptually overlaps with runtime service APIs, but this is the in-process authoring surface. |
| `DefaultConversationSession` | Live session manager | Owns the reusable downstream ACP conversation for one nanoboss session binding. | `/default` and any inherited default-conversation work need continuity. | Overlaps with `PersistentAcpSession` and the persisted `defaultAcpSessionId`; three layers of one conversation concept. |
| `PersistentAcpSession` | Low-level ACP wrapper | Holds the actual downstream ACP connection and session id. | The default conversation needs connection reuse, session loading, token snapshots, and update handling. | Internal half of `DefaultConversationSession`. |
| `DownstreamAgentConfig` | Executable config | Full spawn/runtime config: provider, command, args, cwd, env, model, reasoning effort. | Nanoboss has to actually launch a downstream CLI/agent. | Overlaps with `DownstreamAgentSelection`, which is the smaller public subset. |
| `DownstreamAgentSelection` | Public selection | Provider/model choice without transport command details. | Lets users and procedures switch models safely without rewriting the process config. | A partial view of `DownstreamAgentConfig`. |
| `AgentTokenSnapshot` | Raw metric capture | Provider-specific token/context metrics captured from ACP or logs. | Preserve fidelity to the original metric source. | Overlaps with `AgentTokenUsage`; snapshot is raw, usage is normalized. |
| `AgentTokenUsage` | Normalized metric view | Display-friendly token/context usage for procedures and frontends. | Procedures like `/tokens` and `/model` need one stable metric shape. | Intentional normalized duplicate of `AgentTokenSnapshot`. |
| `FrontendCommand` | UI metadata | Name/description/input hint for command palettes and autocompletion. | Frontends need a compact discoverability surface. | Overlaps with procedure metadata plus local TUI-only commands. |
| `FrontendEvent` | Live event model | Events sent to frontends: run started/completed, tool updates, token usage, cards, status, continuation updates. | Nanoboss renders long-running work incrementally rather than as one final blob. | Partially overlaps with persisted replay events and with stored cell output. |
| `SessionEventLog` | Live event history | Bounded in-memory event log for one session. | SSE and TUI need replay of recent live events without rehydrating from disk. | Overlaps with persisted replay events on cells; one is live/ephemeral, the other durable/per-run. |
| `ReplayableFrontendEvent` / `PersistedFrontendEvent` | Durable event subset | The subset of UI events safe to persist on a cell for restoration. | Restoring session output should not require rerunning the procedure. | Another projection of frontend events. |
| `ProcedureMemoryCard` | Distilled memory object | Compact summary of prior non-default top-level procedure results. | Default conversation prompts need a bounded, ref-heavy memory mechanism. | Overlaps with cell summary plus output `memory` and `summary`; this is the prompt-friendly packaging. |
| `ProcedureDispatchJob` | Async work record | Durable state machine for MCP-started background procedure dispatch. | Agents need to start work asynchronously and poll later without holding the caller open. | Overlaps with the top-level cell that the job eventually produces. |
| `dispatchId` / `dispatchCorrelationId` | Identity handles | `dispatchId` identifies the job record; `dispatchCorrelationId` ties job, cancellation, timing, and recovered cell together. | Recovery and dedupe need an id that survives transport failures and retries. | Two ids for one dispatch concept; likely necessary but easy to confuse. |
| `RuntimeService` / nanoboss MCP tool surface | Inspection facade | Read-only and dispatch APIs exposed through the global `nanoboss` MCP server. | Downstream agents need one stable introspection/control plane for nanoboss state. | Overlaps with in-process `ctx.state` and registry APIs; same data, different transport. |
| Agent transcript log | Debug data store | JSONL transcript of ACP transport activity under `~/.nanoboss/agent-logs`. | Needed to debug downstream agent transport issues. | Overlaps with stored agent cells and timing traces, but at a much lower level and intentionally blocked from broad inspection. |
| Procedure roots / procedure packages | Extension layout | Built-in `procedures/`, workspace `.nanoboss/procedures/`, and profile `~/.nanoboss/procedures/`. | Nanoboss wants both built-in and user-defined commands with one model. | Overlaps with the registry; this is the filesystem side of the same concept. |
| `TypeDescriptor` / `jsonType` / `explicitDataSchema` / `dataShape` | Structured-data contract | Typed JSON result descriptors and their stored schema/shape metadata. | Nanoboss wants downstream structured outputs to be valid, inspectable, and durable. | `explicitDataSchema` and inferred `dataShape` overlap as two schema-ish representations of one value. |
| `RunTimingTrace` | Timing artifact | Per-run trace of key execution milestones. | Performance and recovery debugging need a durable chronology. | Overlaps with transcript logs and dispatch progress logs. |

### Repo Quality And Workflow Objects

| Noun | Kind | Intended purpose | Why does this exist | Suspected duplicate / overlap |
| --- | --- | --- | --- | --- |
| `CachedPreCommitChecksResult` / `PreCommitChecksResult` / `ResolvedPreCommitChecksResult` | Validation result family | Captures cached and fresh results for `bun run check:precommit`. | Commits and validation workflows should not rerun expensive checks when the repo fingerprint is unchanged. | Strong overlap across layers; these are cache, public, and resolved variants of the same concept. |
| Workspace state fingerprint / runtime fingerprint | Cache keys | Hashes repo state and runtime environment for pre-commit cache validity. | A cached validation result is only safe if both workspace and runtime match. | Overlaps with repo fingerprinting used elsewhere, especially simplify2. |
| Pre-commit marker events / phase results | Structured progress marker | Encodes `lint`, `typecheck`, and `test` phase starts/results inside command output. | Lets nanoboss stream progress while still consuming one shell command. | Overlaps with plain output streaming and with higher-level procedure status cards. |
| `LinterError` / `LintExecutionPlan` / `LintRunResult` | Linter workflow objects | Describe detected errors, how to run the linter, and the result of a run/fix loop. | `/linter` is designed to adapt to the repo rather than hardcode one linter path. | Overlaps with pre-commit lint phase and with simplify workflows that may also touch tests and cleanup. |

### Workflow Package Nouns

| Noun | Kind | Intended purpose | Why does this exist | Suspected duplicate / overlap |
| --- | --- | --- | --- | --- |
| `SimplifyState` / `SimplifyOpportunity` / `SimplifyDecision` / `SimplifyHistoryEntry` | Paused simplification loop | Represents one-at-a-time simplification discovery, user choice, and history. | `/simplify` is an explicitly resumable workflow rather than a one-shot rewrite command. | Overlaps directly with simplify2, which is a more formalized successor. |
| Simplify2 `Observation`, `EvidenceRef`, `Hypothesis`, `Checkpoint`, `TestSlice`, `HumanDecision`, `AppliedSlice`, focus-picker entries | Conceptual simplification model | Richer model for architecture-focused simplification with explicit human checkpoints and validation slices. | `/simplify2` needs a more explicit conceptual model than `/simplify` to reason about architecture, evidence, and checkpoints. | Strong overlap with `/simplify`; likely partial succession rather than orthogonal scope. |
| `AutoresearchState` | Repo-local optimization state | Stores current bounded autoresearch session: goal, benchmark, checks, best run, branch, iterations, notes. | `/autoresearch/*` needs durable repo-local state across runs and pauses. | Overlaps with session metadata and with simplify2's longer-running improvement loop, but has a benchmark-driven objective. |
| `AutoresearchExperimentRecord` | Experiment ledger | Durable per-run record of idea, rationale, benchmark result, checks, and keep/reject decision. | Optimization needs auditability and a trail of experiments. | Overlaps with git history and with session cells; this is the repo-local optimization-specific record. |
| Autoresearch benchmark / check / decision / finalize branch objects | Optimization domain model | Define how to measure improvement, gate quality, decide whether to keep a change, and split wins into branches. | The autoresearch workflow is opinionated enough to need a local domain language. | Overlaps with pre-commit checks and commit workflows. |
| `KnowledgeBasePaths` | KB filesystem layout | Canonical raw/wiki/derived/manifests/queues/state layout under a repo. | The KB procedures need deterministic file locations and manifests. | Overlaps with general repo artifacts directories. |
| `RawSourceFile` / `SourceManifestEntry` | Source inventory | Track raw source files plus their compiled summary metadata, tags, concepts, and questions. | The KB pipeline starts with repeatable source ingestion and compilation state. | Overlaps with compiled source pages in `wiki/sources`; manifest vs page duplication is intentional. |
| `ConceptManifestEntry` | Concept page manifest | Records compiled concept pages and their source fingerprints/relationships. | `/kb/compile-concepts` and `/kb/link` need a concept-level inventory. | Overlaps with linked wiki pages themselves and link-state outputs. |
| `AnswerManifestEntry` | Answer page manifest | Records derived answer pages generated from the KB. | Answers are durable artifacts, not just chat output. | Overlaps with top-level session cells and with `wiki/answers` pages. |
| `RenderManifestEntry` | Render artifact manifest | Records derived reports/decks built from KB pages. | `/kb/render` outputs should be discoverable and durable. | Overlaps with files in `derived/reports` and `derived/slides`. |
| `LinkStateRecord` | Graph/link report | Stores index/backlink/orphan/duplicate concept analysis. | `/kb/link` needs a durable picture of corpus structure and maintenance problems. | Overlaps with health output and concept manifests. |
| `HealthRepairIssue` / health queue | Repair backlog | Deterministic list of KB consistency issues to repair. | `/kb/health` needs an actionable queue, not just a warning blob. | Overlaps with `LinkStateRecord` orphan/duplicate analysis. |
| `ResearchBrief` / `ResearchResult` | Research workflow objects | Describe the brief and final output for `/research`. | The research flow separates brief generation from isolated execution. | The file exists, but `/research` is not registered in `src/procedure/registry.ts`; this is a dormant or orphaned command surface. |

## Verbs

### Frontend, Harness, And Composition Actions

| Verb / action | Surface | Intended purpose | Why does this exist | Suspected duplicate / overlap |
| --- | --- | --- | --- | --- |
| Create session | Service | Start a new nanoboss session bound to a cwd and optional agent selection. | Every interaction needs an owning session boundary. | Overlaps with `/new`, which is the frontend-level way to trigger it. |
| Resume session | Service | Rehydrate a prior session from metadata and stored state. | Sessions are meant to outlive one process. | Overlaps with current-session fallback in runtime/MCP. |
| Resolve command | Service | Map user input to `/default`, a slash procedure, or a pending continuation target. | Nanoboss supports plain chat, slash commands, and paused resumptions with one prompt entry point. | Overlaps with TUI-local command parsing. |
| Start a new session (`/new`) | TUI-local command | Reset the frontend into a fresh session. | Users need a fast UI-level reset. | Frontend-only alias over service session creation. |
| Exit frontend (`/end`, `/quit`, `/exit`) | TUI-local command | Leave the interactive frontend. | Pure UI control should not hit the service. | Three synonyms for one action. |
| Change tool-card theme (`/dark`, `/light`) | TUI-local command | Switch local rendering theme. | This is presentation state, not harness state. | Two theme toggles for one setting. |
| Pick or set model (`/model`) | Harness command + TUI affordance | Inspect available providers/models or change the session default selection. | The current downstream model is session state that procedures depend on. | Strong overlap: it is simultaneously a TUI-local picker affordance and a harness procedure. |
| Show token usage (`/tokens`) | Procedure | Display latest normalized token/context metrics for the default agent session. | Users need visibility into context pressure. | Semantically a harness/session inspection command even though it is modeled as a procedure. |
| Dismiss continuation (`/dismiss`) | Harness command | Clear the active pending procedure continuation. | Users need to escape a paused workflow without replying to it. | Another session-state command that lives adjacent to procedures. |
| Execute top-level procedure | Procedure runner | Run a procedure, persist its root cell, and return refs/results. | All top-level commands need uniform persistence, error handling, and token capture. | Overlaps with async dispatch worker execution; same work, different trigger path. |
| Resume paused procedure | Procedure runner | Invoke `procedure.resume(...)` against stored continuation state. | Paused workflows would otherwise need bespoke service logic. | Overlaps with plain command execution but adds resume-state lookup. |
| Run downstream agent in `fresh` mode | `ctx.agent.run` | Spawn an isolated downstream ACP session for one call. | Most sub-tasks should not mutate the default conversation. | Overlaps with `callAgent(...)`; one is context-bound and one is standalone. |
| Run downstream agent in `default` mode | `ctx.agent.run(..., { session: "default" })` | Continue the master/default conversation. | Some procedures need conversational continuity. | Overlaps with `/default`; this is the primitive, `/default` is the named user command. |
| Run nested procedure in `inherit` / `default` / `fresh` mode | `ctx.procedures.run` | Compose procedures while controlling default-conversation binding. | Complex workflows need reuse of procedures without flattening everything into one prompt. | Overlaps with top-level procedure execution modes and with downstream agent session modes. |
| Validate typed JSON and retry parsing | Agent invocation | Ask downstream agents for schema-shaped JSON and retry when parse/validation fails. | Structured workflows would otherwise be too brittle. | Overlaps with `jsonType`/schema nouns and with explicit result schemas stored on cells. |
| Emit UI text, status, warnings, and cards | Procedure UI API | Stream progress and structured notices back to frontends. | Long-running procedures need richer incremental feedback than raw text only. | Overlaps with frontend events; this is the producer side. |
| Collect and sync memory cards | Service | Derive unsynced procedure memory cards and inject them into future default-conversation prompts. | Durable history needs a bounded "what matters" summary, not blind replay. | Overlaps with cell summaries, output memory, and replay events. |

### Durable State, Inspection, And Dispatch Actions

| Verb / action | Surface | Intended purpose | Why does this exist | Suspected duplicate / overlap |
| --- | --- | --- | --- | --- |
| Start / append / finalize / patch cell | `SessionStore` | Create the durable record of a run and incrementally add stream or patches. | All higher-level execution surfaces converge on cells. | Different methods over one persistence concept. |
| List top-level runs | `ctx.state` + MCP `top_level_runs` | Return chat-visible completed top-level runs. | This is usually the right starting point for retrieval. | Overlaps with `session_recent`; the docs explicitly warn to prefer `top_level_runs` in most cases. |
| Scan session recent | `ctx.state` + MCP `session_recent` | Return recent completed cells across the whole session. | Sometimes the caller truly wants a global recency scan. | Strong overlap with `top_level_runs` and traversal APIs; easy to misuse. |
| Traverse ancestors | `ctx.state` + MCP `cell_ancestors` | Walk upward from a cell to find parents and owning top-level runs. | Nested procedure/agent cells need contextualization. | Complements `cell_descendants`; together they are a tree-navigation surface. |
| Traverse descendants | `ctx.state` + MCP `cell_descendants` | Walk downward from a cell into nested procedure and agent calls. | One top-level run may contain many nested actions. | Overlaps with `children`; one is a specialized bounded case of the other. |
| Get exact cell | `ctx.state` + MCP `cell_get` | Read one authoritative stored cell record. | Summaries are not enough when exact metadata or output is needed. | Overlaps with top-level run listings and summary projections. |
| Read ref | `ctx.state` + MCP `ref_read` | Read the exact value at a stored ref path. | Ref-heavy data is only useful if callers can dereference it. | Overlaps with embedding raw data directly in outputs; refs are the preferred path. |
| Stat ref | `ctx.state` + MCP `ref_stat` | Inspect type/size/preview before full read. | Reduces accidental large reads and improves discoverability. | Overlaps with `get_schema`; both are pre-read inspection tools. |
| Write ref to file | `ctx.state` + MCP `ref_write_to_file` | Materialize a durable ref into a workspace file. | Some outputs are more useful as files than chat blobs. | Overlaps with direct file-writing procedures. |
| Get schema / shape | MCP `get_schema` | Return compact inferred shape and optional explicit schema for a cell or ref. | Callers need structural guidance before consuming stored data. | Overlaps with `ref_stat` and stored `explicitDataSchema`. |
| List procedures | Registry + MCP `procedure_list` | Enumerate available procedures in a workspace/profile context. | Discoverability across built-ins and disk procedures. | Overlaps with frontend command lists; different audience and transport. |
| Get one procedure | Registry + MCP `procedure_get` | Return metadata for one procedure. | Callers sometimes need exact command metadata before dispatching. | Mostly a filtered view over the registry. |
| Create procedure (`/create`) | Procedure | Generate a new procedure from natural-language instructions and persist it to a procedure root. | Extensibility is a first-class feature, not a manual code-edit-only workflow. | Overlaps with direct disk authoring of `.nanoboss/procedures/*`; `/create` automates that path. |
| Load and persist disk procedures | Registry | Discover, lazily load, and write workspace/profile procedure modules. | User-defined commands need a supported lifecycle. | Overlaps with built-in procedures; same abstraction, different source. |
| Start async procedure dispatch | MCP `procedure_dispatch_start` | Kick off a background slash command and return immediately. | Downstream agents cannot always wait synchronously for long harness work. | Overlaps with direct top-level execution; same command, different invocation transport. |
| Check or wait on dispatch | MCP `procedure_dispatch_status` / `procedure_dispatch_wait` | Poll or block briefly for dispatch progress/result. | Agents need a recoverable async workflow. | `status` and `wait` are very similar; `wait` is the favored convenience wrapper. |
| Cancel dispatch by correlation id | Job manager | Mark matching jobs cancelled and request soft stop. | Long-running background work must be interruptible. | Overlaps with top-level run cancellation and soft-stop semantics. |
| Recover async dispatch into default conversation | Dispatch recovery | Reconcile a durably finished cell back into the persistent conversation when the outer polling path failed. | Prevents losing conversation continuity when dispatch delivery fails after durable completion. | Another recovery-oriented projection of the same finished run. |

### Built-In Procedure Actions

| Verb / action | Surface | Intended purpose | Why does this exist | Suspected duplicate / overlap |
| --- | --- | --- | --- | --- |
| Pass prompt through (`/default`) | Procedure | Continue the default downstream conversation with the user's prompt. | Plain chat needs to be a first-class procedure path. | Hidden from normal metadata listings, but it is the canonical fallback action. |
| Get a second opinion (`/second-opinion`) | Procedure | Ask the current default model for an answer, then ask Codex to critique and revise it. | Encodes a specific multi-model review pattern as a reusable command. | Overlaps with manual "ask another model" workflows. |
| Fix all linter errors (`/linter`) | Procedure | Discover lint setup, run it, and iteratively fix errors. | Common repo maintenance should be automated. | Overlaps with `nanoboss/pre-commit-checks` lint phase and with simplification workflows that clean code. |
| Simplify one opportunity at a time (`/simplify`) | Harness procedure | Find a simplification opportunity, pause for a user decision, then apply/skip/continue. | Encourages bounded, resumable simplification instead of one giant rewrite. | Direct overlap with `/simplify2`; probably predecessor vs successor. |
| Model conceptual simplification with checkpoints (`/simplify2`) | Harness procedure | Run a richer bounded simplification loop with observations, hypotheses, checkpoints, and validation. | The simpler workflow was not expressive enough for architecture-level simplification. | Strong overlap with `/simplify`, `/autoresearch`, and repo-quality commands. |
| Run or replay repo pre-commit validation (`/nanoboss/pre-commit-checks`) | Procedure | Use cached or fresh `check:precommit` results and optionally attempt one automated fix pass. | Validation gating should be explicit and cheap when unchanged. | Overlaps with `/linter` and with the commit workflow. |
| Validate then create a commit (`/nanoboss/commit`) | Procedure | Gate a descriptive git commit on successful pre-commit checks. | Nanoboss wants a safe commit path built on top of existing validation. | Thin composition layer over `nanoboss/pre-commit-checks` plus an agent-generated commit command. |
| Show autoresearch command surface (`/autoresearch`) | Procedure | Present the explicit v1 autoresearch command surface. | A package with many subcommands needs an entrypoint/help surface. | Overlaps with the explicit subcommands; mostly a menu/alias. |
| Start autoresearch (`/autoresearch/start`) | Procedure | Initialize repo-local optimization state and run a bounded foreground loop. | Benchmark-driven improvement needs a durable starting point. | Overlaps with simplify2's iterative improvement idea, but is metric-driven. |
| Continue autoresearch (`/autoresearch/continue`) | Procedure | Continue the current repo-local autoresearch session. | Long loops should be resumable. | Paired with `start`; essentially the same loop at a later time. |
| Inspect autoresearch status (`/autoresearch/status`) | Procedure | Show current repo-local autoresearch state. | Users need visibility into active optimization runs. | Semantically a harness-like inspection command. |
| Clear autoresearch state (`/autoresearch/clear`) | Procedure | Delete repo-local autoresearch artifacts after stopping. | The workflow needs an explicit teardown/reset. | Overlaps with manual filesystem cleanup. |
| Finalize autoresearch wins (`/autoresearch/finalize`) | Procedure | Split kept improvements into review branches from the merge base. | The workflow is designed to produce reviewable branches, not just local state. | Overlaps with commit and git branch management. |
| Ingest raw sources (`/kb/ingest`) | Procedure | Scan raw sources and update KB manifests. | The KB pipeline starts from durable source inventory. | Part of the larger `/kb/refresh` pipeline. |
| Compile one source (`/kb/compile-source`) | Procedure | Convert one ingested source into a durable wiki page. | The KB needs structured compiled pages, not just raw inputs. | Also subsumed by `/kb/refresh`. |
| Compile concepts (`/kb/compile-concepts`) | Procedure | Build concept pages from compiled source summaries. | The KB supports concept-level synthesis, not just source pages. | Also part of `/kb/refresh`. |
| Link KB structure (`/kb/link`) | Procedure | Rebuild indexes, backlinks, orphan/duplicate reports, and structural outputs. | KB maintenance needs graph-aware reports. | Overlaps with `/kb/health`; both surface structural problems. |
| Render derived outputs (`/kb/render`) | Procedure | Generate reports or decks from stored KB pages. | The KB is meant to produce downstream artifacts, not just source pages. | Overlaps with `/research` report generation at a high level. |
| Check KB health (`/kb/health`) | Procedure | Write deterministic repair issues and a repair queue. | Structural drift should become an actionable backlog. | Overlaps with `/kb/link` orphan/duplicate reporting. |
| Refresh the KB (`/kb/refresh`) | Procedure | Run the end-to-end refresh pipeline from raw sources through linking and optional health. | Users need one umbrella command for the common path. | Explicit overlap with `ingest`, `compile-source`, `compile-concepts`, `link`, and `health`; it is the composed superset. |
| Answer from the KB (`/kb/answer`) | Procedure | Answer a question using compiled KB pages and write a durable answer page. | Turns the KB from an index into a question-answering workflow. | Overlaps with `/research` in output shape, but uses repo-local compiled corpus instead of open-ended research. |
| Research a topic with a cited report (`/research`) | Procedure file only | Build a brief, run isolated research, and write a report to `plans/`. | Useful as a reusable research workflow and as an example for `/create`. | Present in `procedures/research.ts` but not registered in the built-in registry, so it is currently a dormant/unreachable command surface. |

## High-Confidence Overlaps And Suspected Duplicates

| Area | Observation | Why it matters |
| --- | --- | --- |
| Session identity | `Session`, `SessionMetadata`, live `SessionState`, and `current-sessions.json` all represent the same session at different layers. | The layering is defensible, but the naming makes it easy to forget which copy is authoritative for what. |
| Run identity | "Run", "cell", `CellRecord`, `CellSummary`, `RunResult`, and `ProcedureExecutionResult` are all projections of one execution record. | This is the biggest vocabulary tax in the codebase. A glossary or stricter naming split would help. |
| Pause/continuation | `ProcedurePause`, `PendingProcedureContinuation`, suggested replies, and structured continuation UI all express one paused-state concept. | The layering works, but it is cognitively heavy and spread across service, types, repository parsing, and frontend events. |
| Model state | `/model`, `DownstreamAgentSelection`, `DownstreamAgentConfig`, the TUI picker, and persisted default ACP session state all touch one "default model" idea. | This is already called out in the command-surface formalization plan and remains a real ambiguity. |
| Token metrics | `AgentTokenSnapshot` and `AgentTokenUsage` are intentionally separate raw vs normalized views. | Reasonable duplication, but callers must know which layer they need. |
| Event persistence | `SessionEventLog` and persisted replay events both store UI history. | The split is useful, but one is live and one is durable; that distinction is easy to miss. |
| Retrieval APIs | `top_level_runs`, `session_recent`, `cell_get`, `cell_ancestors`, `cell_descendants`, `ref_read`, `ref_stat`, and `get_schema` create several overlapping retrieval paths. | This is powerful, but there is a real "which one should I use?" burden. The MCP tool instructions already compensate for this. |
| Simplification workflows | `/simplify` and `/simplify2` solve the same broad problem with different internal models. | This looks like an active migration or exploration rather than a stable long-term dual surface. |
| Repo-quality workflows | `/linter`, `/nanoboss/pre-commit-checks`, and parts of `/nanoboss/commit` overlap heavily. | They are layered intentionally, but user-facing boundaries may still feel fuzzy. |
| KB maintenance workflows | `/kb/refresh` composes work already exposed individually via `ingest`, `compile-source`, `compile-concepts`, `link`, and `health`. | This overlap is probably intentional and useful, but it should be documented as composition, not duplication. |
| Research surfaces | `/research` and `/kb/answer` both generate durable written artifacts, while `/research` is not even registered. | This is the clearest likely dead or transitional surface in the repo today. |
| Async dispatch ids | `dispatchId` and `dispatchCorrelationId` both identify "the dispatch". | The second id is needed for recovery and dedupe, but the naming invites confusion. |

## Bottom Line

Nanoboss's core ontology is:

1. A `session` owns live agent continuity plus durable `cells`.
2. `cells` and `refs` are the canonical stored memory model.
3. `procedures` are the command abstraction, but command classification is not fully normalized yet.
4. `default conversation` and `fresh agent runs` are the two main execution verbs.
5. The global `nanoboss` MCP surface is a read/dispatch facade over the same session store.

The main suspected cleanup candidates are:

1. The command taxonomy around frontend commands, harness commands, and procedures, especially `/model` and likely `/tokens`.
2. The duplicated language around run/cell/result objects.
3. The coexistence of `/simplify` and `/simplify2`.
4. The dormant `procedures/research.ts` surface.
