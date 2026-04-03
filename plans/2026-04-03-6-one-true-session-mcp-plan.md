# One true session-MCP convergence plan

## Goal

Eliminate the duplicate MCP execution path and converge nanoboss on a single, session-pinned MCP implementation.

After this change, nanoboss should have exactly one real MCP path for procedure dispatch and session inspection:

- implementation: `src/session-mcp.ts`
- transport: `src/session-mcp-stdio.ts`
- attachment: `src/mcp-attachment.ts`

The obsolete top-level static MCP proxy path must be removed.

## Root cause

Today the repo has two overlapping MCP surfaces:

1. the attached session MCP server (`nanoboss-session`), which is correctly pinned to a specific nanoboss session via `--session-id`, `--cwd`, and `--root-dir` in `src/session-mcp-stdio.ts`
2. the top-level static MCP proxy (`nanoboss`) in `src/mcp-proxy.ts`, which exposes nearly the same tool family but is not truly session-pinned and falls back to ambient state

Async slash-command dispatch now depends on session-only tools:

- `procedure_dispatch_start`
- `procedure_dispatch_wait`

Those are implemented in `src/session-mcp.ts` and intentionally blocked from the top-level proxy in `src/mcp-proxy.ts`.

That split creates an invalid intermediate architecture:

- prompts in `src/service.ts` require the attached session MCP path
- but real runs can still expose only the top-level `nanoboss-*` surface
- so slash commands like `/research` fail when the agent cannot see the attached `nanoboss-session` tools

This is not a pi-tui problem; it is an architectural duplication problem.

## Desired end state

There is only one MCP implementation path:

- downstream ACP sessions always receive the attached stdio session MCP server from `buildSessionMcpServers()` in `src/mcp-attachment.ts`
- all procedure dispatch and session inspection tools are served by `SessionMcpApi` in `src/session-mcp.ts`
- no top-level static `nanoboss` MCP proxy exists
- no prompt text or runtime logic refers to choosing between `nanoboss` and `nanoboss-session`
- real execution paths do not depend on `readCurrentSessionPointer()` fallback

## In scope

- remove obsolete top-level MCP proxy code
- remove obsolete MCP registration/config plumbing for the proxy
- simplify dispatch prompting and tests to assume only the attached session MCP exists
- tighten session-MCP usage so internal execution paths are explicitly session-pinned
- update docs/help/tests accordingly

## Out of scope

- redesigning ACP itself
- changing user-facing slash command names
- changing procedure semantics unrelated to MCP transport
- introducing a new networked MCP transport

## Files to change

### Delete or fully retire

- `src/mcp-proxy.ts`
- `src/mcp-registration.ts` if it is only for the obsolete top-level proxy path
- any CLI entrypoints/help text that expose `nanoboss mcp proxy`

### Keep as the canonical path

- `src/session-mcp.ts`
- `src/session-mcp-stdio.ts`
- `src/mcp-attachment.ts`
- `src/service.ts`
- `src/default-session.ts`
- `src/call-agent.ts`

### Likely follow-on updates

- `nanoboss.ts`
- `cli.ts`
- `src/doctor.ts`
- tests under `tests/unit/*` and `tests/e2e/*`
- any docs/plans/help text mentioning a global `nanoboss` MCP server

## Implementation steps

### 1. Remove the top-level MCP proxy surface

Delete the code path that launches or describes the static `nanoboss` MCP proxy.

Concretely:

- remove `runMcpCommand()` / `printMcpHelp()` usage if they only exist for the obsolete proxy
- remove any CLI command wiring that exposes `nanoboss mcp proxy`
- remove tests that validate the static proxy behavior

If any external user-facing MCP command must remain for compatibility, it should fail fast with a clear message that global MCP proxy mode was removed and session-attached MCP is now the only supported path.

Preferred outcome: delete the command entirely.

### 2. Remove proxy registration plumbing

Delete the global MCP registration/config path that exists to install `nanoboss mcp proxy` into other CLIs.

Concretely review and remove or simplify:

- `src/mcp-registration.ts`
- `src/doctor.ts` rows/labels/statuses that talk about configured MCP proxy state
- any README/help text that describes registering a global `nanoboss` MCP server

If doctor still needs to report MCP health, it should only report whether nanoboss can attach the local session MCP for ACP sessions, not whether a separate global proxy is configured.

### 3. Make session-pinned MCP the only internal path

Ensure all internal agent execution uses the attached session MCP server created by:

- `src/mcp-attachment.ts`
- `src/session-mcp-stdio.ts`

Verify all real agent invocation sites already pass explicit session MCP context:

- `src/default-session.ts`
- `src/call-agent.ts`
- `src/context.ts`

No internal dispatch path should rely on a separately registered top-level MCP server.

### 4. Remove server-choice language from dispatch prompts

Simplify `buildProcedureDispatchPrompt()` in `src/service.ts`.

Delete defensive text added only because two MCP surfaces coexisted, including lines like:

- use the attached `nanoboss-session` MCP server
- if another MCP server named `nanoboss` is also available, do not use it

The prompt should only describe the one true dispatch flow:

1. call `procedure_dispatch_start`
2. poll `procedure_dispatch_wait`
3. return the final tool result text or error text exactly

### 5. Tighten session identity requirements

`SessionMcpApi.createStore()` in `src/session-mcp.ts` currently falls back to `readCurrentSessionPointer()` when `sessionId` is absent.

That fallback is hazardous in a one-true-path design because it reintroduces ambient session resolution.

Preferred fix:

- require explicit `sessionId` for all real execution paths
- remove or sharply limit fallback-to-current-session behavior

Acceptable compromise if needed for debugging:

- keep fallback only for explicitly debug-oriented local tooling
- document it as non-production convenience
- do not let internal dispatch or agent-facing attached MCP depend on it

### 6. Decide what to do with slash wrappers for session inspection

`src/session-tool-procedures.ts` duplicates session inspection capabilities already exposed via `src/session-mcp.ts` tools like:

- `top_level_runs`
- `session_recent`
- `cell_get`
- `ref_read`
- `get_schema`

Choose one of these and implement it consistently:

#### Preferred
Remove these slash inspection procedures and require MCP for inspection.

#### Acceptable
Keep them as ultra-thin wrappers over the exact same underlying `SessionStore`/`SessionMcpApi` behavior, with no independent logic.

Do not leave them as a second feature surface with separate semantics.

### 7. Update tests to reflect the converged architecture

Delete tests that validate the obsolete top-level proxy behavior, including `tests/unit/mcp-proxy.test.ts` if no proxy remains.

Strengthen tests around the canonical path:

- `tests/unit/mcp-attachment.test.ts`
- `tests/unit/session-mcp.test.ts`
- `tests/unit/service.test.ts`
- `tests/unit/session-mcp-stdio.test.ts`
- any e2e coverage that exercises slash dispatch via attached session MCP

Required assertions:

- slash commands dispatch successfully through attached session MCP tools
- downstream sessions always include the attached `nanoboss-session` stdio server
- there is no remaining code path that expects or advertises top-level `nanoboss` MCP dispatch tools
- help text / doctor output / CLI commands no longer mention global proxy registration if removed

## Acceptance criteria

A change is complete only if all of the following are true:

1. There is no runtime code path that serves a separate static `nanoboss` MCP proxy.
2. `src/session-mcp.ts` is the sole implementation for procedure dispatch and session inspection MCP tools.
3. Internal agent execution attaches the session MCP explicitly and does not rely on a globally registered MCP server.
4. `src/service.ts` no longer contains prompt text about choosing between `nanoboss` and `nanoboss-session`.
5. Real execution paths do not rely on ambient current-session fallback.
6. Tests pass with only the session-attached MCP architecture.
7. `/research` and other slash commands work through the attached session MCP path in one shot.

## Suggested validation checklist

Run at least:

- `bun test`
- targeted tests for session MCP / dispatch / TUI / service

Manually validate:

1. start nanoboss normally
2. run a slash command like `/research what changed today`
3. confirm tool activity shows `procedure_dispatch_start` and `procedure_dispatch_wait`
4. confirm there is no dependency on a separate globally registered `nanoboss` MCP server

## Risks

- deleting `mcp-registration.ts` may affect doctor/help UX; keep only what is still meaningful after proxy removal
- removing current-session fallback too aggressively could break ad hoc local debugging tools; if retained, isolate it from real execution paths
- session inspection slash wrappers may have users; if removed, ensure replacement guidance is clear

## Recommended 1-shot order

1. remove CLI/proxy/registration code
2. simplify `src/service.ts` dispatch prompt
3. tighten session identity in `src/session-mcp.ts`
4. remove or collapse session inspection wrappers
5. update tests and help text
6. run `bun test`

## Non-goals to avoid during the fix

- do not add a compatibility shim that preserves both MCP paths
- do not introduce a new aliasing layer between `nanoboss` and `nanoboss-session`
- do not keep the proxy around as a “temporary fallback”

The point of this plan is architectural convergence, not coexistence.
