# `@nanoboss/adapters-http`

`@nanoboss/adapters-http` is the HTTP/SSE protocol adapter for Nanoboss. It
exposes live Nanoboss sessions over JSON endpoints and streams runtime events as
server-sent events for local frontends such as the TUI.

It owns:

- the HTTP server entrypoint used by `nanoboss http`
- HTTP client helpers used by local frontends
- private local server supervision for the TUI
- SSE parsing and event stream reconnection
- HTTP aliases for adapter-neutral runtime events
- HTTP request parsing and response status decisions

It does not own:

- session orchestration or procedure execution
- durable storage
- downstream ACP transport
- TUI rendering or reducer behavior
- MCP protocol handling
- generic build/workspace identity helpers

Those boundaries matter:

- `@nanoboss/app-runtime` owns `NanobossService` and runtime event projection.
- `@nanoboss/app-support` owns build and workspace identity helpers.
- `@nanoboss/procedure-sdk` owns prompt-input parsing and normalization.
- `@nanoboss/adapters-tui` consumes this package as a frontend transport.

## Public Interface

The public entrypoint is `packages/adapters-http/src/index.ts`. Its exports are
explicit so test seams and route-parser internals do not become accidental
protocol APIs.

### Server

- `startHttpServer(...)`
- `HttpServerOptions`

This is the command-facing server API. The top-level `src/commands/http.ts`
parses CLI options and calls this function.

### Client

- `getServerHealth(...)`
- `requestServerShutdown(...)`
- `createHttpSession(...)`
- `resumeHttpSession(...)`
- `setSessionAutoApprove(...)`
- `sendSessionPrompt(...)`
- `cancelSessionRun(...)`
- `cancelSessionContinuation(...)`
- `startSessionEventStream(...)`
- `ServerHealthResponse`
- `SessionStreamHandle`

These helpers are frontend transport operations. They keep endpoint paths,
JSON bodies, and connection-close behavior in one place so the TUI does not
duplicate HTTP details. SSE parsing lives in `src/sse-stream.ts` as an internal
client/parser seam.

### Private Server Supervision

- `startPrivateHttpServer(...)`
- `StartedPrivateHttpServer`
- `ensureMatchingHttpServer(...)`

The TUI uses these helpers to either launch a private local HTTP server or
validate a user-supplied server URL before connecting. Lower-level predicates
such as `matchesServerBuild(...)` and `describeWorkspaceMismatch(...)` stay
internal test seams rather than package entrypoint exports.

### Frontend Event Aliases

The package re-exports app-runtime event projection under HTTP/frontend names:

- `FrontendEvent`
- `FrontendEventEnvelope`
- `RenderedFrontendEventEnvelope`
- frontend replay/render/memory type guards
- `mapSessionUpdateToFrontendEvents(...)`
- `mapProcedureUiEventToFrontendEvent(...)`
- `toFrontendCommands(...)`
- `toReplayableFrontendEvent(...)`

The event semantics live in `@nanoboss/app-runtime`; this adapter owns the
HTTP/frontend naming and SSE transport.

## Internal Routes

`startHttpServer(...)` serves:

- `GET /v1/health`
- `POST /v1/admin/shutdown`
- `POST /v1/sessions`
- `POST /v1/sessions/resume`
- `GET /v1/sessions/:id`
- `POST /v1/sessions/:id/auto-approve`
- `POST /v1/sessions/:id/prompts`
- `POST /v1/sessions/:id/cancel`
- `POST /v1/sessions/:id/continuation-cancel`
- `GET /v1/sessions/:id/stream`

Route parsing helpers are kept inside `src/server.ts`. Tests can import that
source file directly for focused coverage, but external callers should use the
server/client APIs above.

## Package Structure

- `src/server.ts`
  Bun HTTP server, route dispatch, prompt body parsing, SSE formatting, and
  admin shutdown endpoint.
- `src/client.ts`
  HTTP client helpers and stream lifecycle behavior.
- `src/sse-stream.ts`
  Internal SSE parser used by the client and focused parser tests.
- `src/event-mapping.ts`
  Frontend-named aliases over app-runtime event projection.
- `src/private-server.ts`
  TUI-owned private server process lifecycle.
- `src/server-supervisor.ts`
  User-supplied server compatibility checks.

## Simplification Rules

- Keep the package barrel explicit; do not reintroduce `export *`.
- Keep route-parser and predicate test seams out of the package entrypoint.
- Keep frontend naming aliases here, but leave event semantics in
  `@nanoboss/app-runtime`.
- Keep process re-entry in `@nanoboss/app-support` through
  `resolveSelfCommand(...)`.
- Keep TUI behavior in `@nanoboss/adapters-tui`; this package should only know
  HTTP/SSE transport.

## Current Review Metrics

Measured during the 2026-05 HTTP adapter review:

- source files: 8
- source lines: 1,061
- largest file: `src/server.ts` at 288 lines
- public barrel wildcard exports: reduced from 5 to 0
- public package symbols: reduced from 51 to 39
- internalized package-entrypoint test seams:
  `parseSessionPromptRequestBody(...)`, `parseSseStream(...)`,
  `matchesServerBuild(...)`, `describeWorkspaceMismatch(...)`,
  `SessionEventLog`, `buildTurnDisplay(...)`, and unused app-runtime event
  guard aliases
  - split prompt request parsing out of `src/server.ts` so the HTTP server
    entrypoint only exports the server start API

This is a public-surface cleanup. Runtime behavior is unchanged; focused tests
still cover the internal parsing seams through source imports and the
supervisor build/workspace checks through `ensureMatchingHttpServer(...)`.

## Good Future Targets

- Split `src/server.ts` route handlers if new endpoints are added, while
  keeping one public `startHttpServer(...)` entrypoint.
- Keep event aliasing thin; any duplicated event projection should move back to
  `@nanoboss/app-runtime`.
