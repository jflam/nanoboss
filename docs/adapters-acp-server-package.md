# `@nanoboss/adapters-acp-server`

`@nanoboss/adapters-acp-server` is the internal ACP stdio server adapter. It
lets an ACP client create Nanoboss sessions, send prompts, receive session
updates, and cancel active work through the live `NanobossService`.

It owns:

- the `nanoboss acp-server` command entrypoint
- ACP agent initialization/session/prompt/cancel handling
- conversion from ACP prompt blocks into Nanoboss prompt input
- ACP session-update forwarding for top-level Nanoboss sessions
- ACP metadata parsing for requested Nanoboss session ids and default agent
  selections
- the ACP-side runtime session factory that exposes Nanoboss MCP inspection

It does not own:

- Nanoboss session orchestration
- procedure execution semantics
- downstream agent ACP transport
- MCP server implementation
- HTTP or TUI protocol behavior
- persistent run/ref/session storage

Those boundaries matter:

- `@nanoboss/app-runtime` owns `NanobossService`.
- `@nanoboss/agent-acp` owns downstream ACP prompt/runtime helpers.
- `@nanoboss/adapters-mcp` owns the global MCP stdio server used for
  inspection.
- `@nanoboss/procedure-engine` owns procedure UI marker conversion.

## Public Interface

The public entrypoint is `packages/adapters-acp-server/src/index.ts`.

It intentionally exports one symbol:

- `runAcpServerCommand()`

`nanoboss.ts` is the production caller. Everything else in
`src/server.ts` is an adapter implementation detail or a test seam.

## Internal Flow

1. `runAcpServerCommand()` announces readiness on stderr.
2. It registers the Nanoboss MCP runtime session factory through
   `@nanoboss/agent-acp`.
3. It creates a live `NanobossService`.
4. It opens an ACP NDJSON stream over stdin/stdout.
5. ACP `newSession` creates a Nanoboss session and emits available commands.
6. ACP `prompt` maps prompt blocks into `PromptInput` and calls
   `NanobossService.promptSession(...)`.
7. ACP `cancel` forwards cancellation to `NanobossService.cancel(...)`.

## Session Updates

`QueuedSessionUpdateEmitter` serializes update delivery to the ACP connection.
It buffers client-facing assistant commentary before a tool call and reclassifies
that pre-tool text as thought chunks when needed, while preserving procedure UI
markers and assistant notices as normal message chunks.

That buffering is ACP presentation policy. It should not move into
`@nanoboss/app-runtime` or `@nanoboss/procedure-engine`.

## Simplification Rules

- Keep the package entrypoint to `runAcpServerCommand()`.
- Keep ACP metadata parsing local to this adapter.
- Keep Nanoboss runtime behavior in `@nanoboss/app-runtime`.
- Keep downstream-agent ACP helpers in `@nanoboss/agent-acp`.
- Keep MCP inspection server construction in `@nanoboss/adapters-mcp`.

## Current Review Metrics

Measured during the 2026-05 ACP server adapter review:

- source files: 4
- source lines: 236
- largest file: `src/server.ts` at 91 lines
- public barrel wildcard exports: reduced from 1 to 0
- public package symbols: reduced from 5 to 1

This is a public-surface cleanup. Tests still cover metadata parsing and update
buffering through internal modules, while consumers only see the command
entrypoint the top-level Nanoboss binary actually calls.

## Good Future Targets

- Keep metadata parsing in `session-metadata.ts` without widening the package
  entrypoint.
- Keep update buffering covered at the adapter boundary because it is specific
  ACP client presentation behavior.
- Revisit whether `Nanoboss` should become a private factory if more ACP agent
  methods are added.
