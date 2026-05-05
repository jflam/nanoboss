# `@nanoboss/adapters-mcp`

`@nanoboss/adapters-mcp` is the MCP stdio adapter for Nanoboss runtime tools.
It exposes procedure dispatch and durable run/ref inspection through MCP tools,
and it registers the global Nanoboss MCP server with supported downstream agent
CLIs.

It owns:

- the global `nanoboss` MCP server name and instructions
- MCP tool metadata and runtime tool dispatch
- stdio JSON-RPC server execution
- MCP registration for Claude, Codex, Gemini, and Copilot
- the MCP stdio server config used by agent runtime sessions

It does not own:

- runtime service behavior
- procedure execution or dispatch job implementation
- durable storage
- HTTP/TUI protocol handling
- process self-command resolution
- downstream ACP prompt/session transport

Those boundaries matter:

- `@nanoboss/app-runtime` owns the `RuntimeService` implementation.
- `@nanoboss/procedure-engine` owns async dispatch jobs.
- `@nanoboss/store` owns durable run/ref/session state.
- `@nanoboss/app-support` owns `resolveSelfCommand(...)`.
- `@nanoboss/adapters-acp-server` uses this package only to mount MCP
  inspection into ACP runtime sessions.

## Public Interface

The public entrypoint is `packages/adapters-mcp/src/index.ts`. It is explicit so
framing, formatting, and individual registration test seams do not become
package-level contracts.

### Runtime MCP Server

- `MCP_SERVER_NAME`
- `MCP_INSTRUCTIONS`
- `runMcpServer(...)`
- `McpServerOptions`
- `listMcpTools()`
- `callMcpTool(...)`

`nanoboss.ts` uses `MCP_SERVER_NAME`, `MCP_INSTRUCTIONS`, and
`runMcpServer(...)` for the `nanoboss mcp` command. Tests and runtime clients
use `listMcpTools()` and `callMcpTool(...)` to exercise the same tool metadata
and dispatch path without stdio framing.

### MCP Registration

- `registerSupportedAgentMcp(...)`
- `buildGlobalMcpStdioServer(...)`
- `McpRegistrationResult`
- `McpServerStdioConfig`

`nanoboss doctor --register` calls `registerSupportedAgentMcp(...)`. Agent ACP
runtime setup uses `buildGlobalMcpStdioServer(...)` to mount the global
inspection server.

Individual helpers such as `registerMcpClaude(...)`, `registerMcpCodex(...)`,
`registerMcpGemini(...)`, and `registerMcpCopilot(...)` are private
implementation details. Tests cover them through `registerSupportedAgentMcp(...)`.

## Internal Seams

The package keeps source-level exports for focused tests:

- JSON-RPC method dispatch in `src/jsonrpc.ts`
- stdio JSON-RPC framing in `src/stdio-jsonrpc.ts`
- MCP result formatting and method dispatch in `src/server.ts`
- per-agent registration helpers in `src/registration.ts`

Those seams are intentionally not exported from the package entrypoint.

## Package Structure

- `src/server.ts`
  MCP tool listing/calling, runtime method dispatch, and stdio server
  entrypoint.
- `src/tool-definitions.ts`
  Runtime-service-backed MCP tool definitions.
- `src/tool-args.ts`
  MCP tool input schemas and argument parsing helpers.
- `src/jsonrpc.ts`
  Generic MCP JSON-RPC method dispatcher.
- `src/stdio-jsonrpc.ts`
  JSONL and Content-Length stdio framing.
- `src/registration.ts`
  Supported-agent MCP registration commands and config writers.

## Tool Surface

The MCP tool list currently includes:

- `procedure_list`
- `procedure_get`
- `procedure_dispatch_start`
- `procedure_dispatch_status`
- `procedure_dispatch_wait`
- `list_runs`
- `get_run_descendants`
- `get_run_ancestors`
- `get_run`
- `read_ref`
- `stat_ref`
- `ref_write_to_file`
- `get_ref_schema`
- `get_run_schema`

Tool semantics should stay in terms of `RuntimeService`; this adapter should
only parse MCP arguments, call runtime methods, and format MCP tool results.

## Simplification Rules

- Keep the package barrel explicit; do not reintroduce `export *`.
- Keep stdio framing and formatter helpers out of the public package surface.
- Add tools by extending the runtime-service-backed tool table, not by reaching
  into store or procedure-engine directly.
- Register all supported agents through `registerSupportedAgentMcp(...)`; keep
  per-agent helpers internal.
- Keep process re-entry in `@nanoboss/app-support`.

## Current Review Metrics

Measured during the 2026-05 MCP adapter review:

- source files: 9
- source lines: 1,240
- largest file: `src/tool-definitions.ts` at 374 lines
- public barrel wildcard exports: reduced from 4 to 0
- public package symbols: reduced from 26 to 10
- internalized package-entrypoint test seams:
  stdio framing helpers, individual agent registration helpers,
  `dispatchMcpMethod(...)`, and `formatMcpToolResult(...)`

This is a public-surface cleanup. Runtime behavior is unchanged; tests still
cover the lower-level seams through direct source imports. MCP result
formatting now lives outside the server entrypoint in `src/tool-result-format.ts`,
and stdio framing lives outside the server loop in
`src/stdio-jsonrpc-framing.ts`. Tool definitions and tool argument parsing now
live in `src/tool-definitions.ts` and `src/tool-args.ts`, keeping
`src/server.ts` focused on list/call dispatch and stdio server wiring.

## Good Future Targets

- Keep `src/tool-definitions.ts` as the runtime-backed tool table while
  preserving the public `runMcpServer(...)` and `callMcpTool(...)` entrypoints.
- Move per-agent config writers into private files if registration logic grows.
- Keep MCP result formatting close to the tool table unless another adapter
  needs the same formatting.
