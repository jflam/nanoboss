# Codebase simplification opportunities

## Updated assumptions

This repo has no external dependents, only one user, and has only existed for a few days. That removes the main reason to preserve backward-compatibility aliases or migration shims. The recommendations below therefore favor direct deletion and consolidation rather than soft deprecation.

## Highest-value simplifications

1. **Trim compatibility aliases and keep one canonical surface for each concept.** The README says nanoboss now has a single unified `nanoboss` entrypoint, and it also says the old script names still route through that unified entrypoint.[S1] `package.json` keeps both `server` and `http` scripts pointing to `bun run nanoboss.ts server`, and it keeps both `cli` and `tui` scripts as separate names.[S2] In the runtime dispatcher, `tui` is explicitly described as an alias and both `cli` and `tui` are routed to `runCliCommand()`.[S3] The Gemini model catalog still includes six entries whose description is literally `Alias`, and `types.ts` defines `AgentResult` as a pure alias of `AgentRunResult`.[S4][S5]

Given the clarified constraints, I would make `http` and `cli` the only user-facing entrypoints, delete the `server` and `tui` aliases, remove the Gemini alias IDs, and remove the `AgentResult` type alias in favor of `AgentRunResult`. Internal plumbing commands such as `acp-server`, `session-mcp`, and `procedure-dispatch-worker` can remain if they still serve distinct internal roles.

2. **Consolidate session persistence so there is one obvious owner of session state.** `SessionStore` owns durable cell storage under a session `cells` directory, writes finalized cell JSON files, and returns refs such as `dataRef`, `displayRef`, `streamRef`, and `rawRef`.[S6] `stored-sessions.ts` separately owns `session.json`, lists session directories from `~/.nanoboss/sessions`, and reconstructs timestamps, prompt text, and default agent selection from cell files when metadata is missing.[S7] `NanobossService` imports both `stored-sessions.ts` and `SessionStore`, and `resume.ts` fabricates session summaries with `hasMetadata: false` and `hasNativeResume: false` when it only has a session id or current-session pointer.[S8][S9]

This is still the strongest architectural simplification target, but I do not mean "add a compatibility layer." I mean "pick one canonical persistence model and one owning module." Conceptually, yes: a session should own its metadata plus its ordered cells, and the rest of the code should query that single model instead of reconstructing session summaries in a second subsystem. That does not require one giant JSON blob on disk; it can still be one session record plus separate cell files. The simplification is one ownership model/API, not one monolithic file format.

3. **Extract the small duplicated helpers that are currently scattered across the repo.** `session-store.ts` has `summarizeText()`, `session-picker-format.ts` has `summarize()`, `tui/format.ts` has `summarizeInline()`, and `context.ts` has another local `summarize()`; each compacts whitespace and truncates text locally.[S6][S10][S11][S12] `requireValue()` is duplicated in both `procedure-dispatch-jobs.ts` and `session-mcp-stdio.ts`.[S13][S14] `parseCliOptions()` and `parseResumeOptions()` both parse the same `showToolCalls`, `showHelp`, and `serverUrl` options, with `resume` only adding `--list` and an optional positional `sessionId`.[S15][S16]

I would extract `src/util/text.ts` for summary helpers, `src/util/argv.ts` for `requireValue()` and similar argument helpers, and a shared frontend connection-options parser for `cli` and `resume`. These are low-risk edits that shrink surface area without changing behavior.

4. **Collapse thin wrappers where the file count is larger than the behavior count.** `docs/architecture.md` already groups the system into HTTP/SSE, ACP over stdio, and session MCP over stdio.[S17] `mcp-proxy.ts` imports `createSessionMcpApi`, `listSessionMcpTools`, `callSessionMcpTool`, and `formatSessionMcpToolResult` from `session-mcp.ts`, creates a current-session-backed API, and forwards those callbacks into `dispatchMcpToolsMethod()`.[S19][S20]

The distinction today is narrow: `session-mcp-stdio.ts` starts a session-bound MCP server and requires an explicit `--session-id`, while `mcp-proxy.ts` starts the same tool surface with current-session fallback and different server identity text.[S14][S19][S20] I would collapse this into one implementation under `src/mcp/`, and likely one top-level command surface that supports both explicit session binding and current-session fallback via flags.

5. **Make the directory tree match the architecture document so agents can infer structure from names.** The architecture doc already groups files by transport and role, and it explicitly lists the files that belong to the HTTP/SSE, ACP, and session MCP clusters.[S17] The live tree still has 54 top-level files directly under `src/` and only one top-level subdirectory, `src/tui/`.[S18] I would keep `commands/` as a separate extension surface, because the README says nanoboss loads extra `.ts` commands from `./commands` and `~/.nanoboss/commands`, and `/create` writes there when run inside the repo.[S1]

## Suggested `src/` layout

The directories below intentionally mirror the transport and state groupings already described in the docs and reduce the number of top-level files a reader must scan before forming a mental model.[S17][S18]

```text
src/
  agent/      # downstream agent runtime, model selection, token accounting
  core/       # service orchestration, context, registry, shared types/config
  http/       # HTTP server/client and frontend event transport
  mcp/        # session MCP, MCP transport, registration, JSON-RPC glue
  options/    # CLI/resume/default connection option parsing
  procedure/  # procedure runner and async dispatch machinery
  session/    # durable cells, session metadata, current-session pointer, cleanup
  tui/        # terminal UI
  util/       # small shared helpers
```

A practical move plan would be: first delete aliases, then extract duplicated helpers, then move files into subdirectories with import-only churn, then collapse the MCP wrappers, and only after that merge the session persistence layers. That order keeps the riskier semantic change last while making the tree easier to navigate early.

## Updated conclusion

The earlier uncertainty about external compatibility risk is now resolved: there is effectively none. That strengthens the recommendation to remove aliases outright, avoid migration shims, and converge faster on a single session model and a single MCP implementation.

## Sources

- [S1] `README.md` lines 9-17, 47-55, 125-130. file:///Users/jflam/agentboss/workspaces/nanoboss/README.md
- [S2] `package.json` lines 6-21. file:///Users/jflam/agentboss/workspaces/nanoboss/package.json
- [S3] `nanoboss.ts` lines 48-79, 83-107. file:///Users/jflam/agentboss/workspaces/nanoboss/nanoboss.ts
- [S4] `src/model-catalog.ts` lines 82-97. file:///Users/jflam/agentboss/workspaces/nanoboss/src/model-catalog.ts
- [S5] `src/types.ts` lines 206-214. file:///Users/jflam/agentboss/workspaces/nanoboss/src/types.ts
- [S6] `src/session-store.ts` lines 72-79, 81-100, 128-185. file:///Users/jflam/agentboss/workspaces/nanoboss/src/session-store.ts
- [S7] `src/stored-sessions.ts` lines 41-52, 86-97, 142-205. file:///Users/jflam/agentboss/workspaces/nanoboss/src/stored-sessions.ts
- [S8] `src/service.ts` lines 12-13, 23-27, 41-42. file:///Users/jflam/agentboss/workspaces/nanoboss/src/service.ts
- [S9] `resume.ts` lines 63-89, 104-121. file:///Users/jflam/agentboss/workspaces/nanoboss/resume.ts
- [S10] `src/session-picker-format.ts` lines 1-16, 50-57. file:///Users/jflam/agentboss/workspaces/nanoboss/src/session-picker-format.ts
- [S11] `src/tui/format.ts` lines 137-144. file:///Users/jflam/agentboss/workspaces/nanoboss/src/tui/format.ts
- [S12] `src/context.ts` lines 514-516. file:///Users/jflam/agentboss/workspaces/nanoboss/src/context.ts
- [S13] `src/procedure-dispatch-jobs.ts` lines 491-497. file:///Users/jflam/agentboss/workspaces/nanoboss/src/procedure-dispatch-jobs.ts
- [S14] `src/session-mcp-stdio.ts` lines 33-37, 77-83. file:///Users/jflam/agentboss/workspaces/nanoboss/src/session-mcp-stdio.ts
- [S15] `src/cli-options.ts` lines 9-47. file:///Users/jflam/agentboss/workspaces/nanoboss/src/cli-options.ts
- [S16] `src/resume-options.ts` lines 11-63. file:///Users/jflam/agentboss/workspaces/nanoboss/src/resume-options.ts
- [S17] `docs/architecture.md` lines 11-55. file:///Users/jflam/agentboss/workspaces/nanoboss/docs/architecture.md
- [S18] Shell listing of `src/` top-level entries from repo root using `find src -maxdepth 1 -type f | sort | nl -ba` and `find src -maxdepth 1 -type d | sort | nl -ba`, showing 54 top-level files and only `src/tui` as a top-level subdirectory.
- [S19] `src/mcp-proxy.ts` lines 1-9, 15-20, 48-64. file:///Users/jflam/agentboss/workspaces/nanoboss/src/mcp-proxy.ts
- [S20] `src/session-mcp.ts` lines 28-30, 65-168, 612-648. file:///Users/jflam/agentboss/workspaces/nanoboss/src/session-mcp.ts
