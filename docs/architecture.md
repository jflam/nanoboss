# nanoboss architecture

This document describes the transport-level architecture of nanoboss.

The key distinction is:

- **frontend transport**: how a user or UI talks to nanoboss
- **agent transport**: how nanoboss talks to downstream agents
- **session inspection transport**: how downstream agents inspect nanoboss session state

## Transport inventory

### 1. Frontend HTTP/SSE
Used when nanoboss runs as an HTTP server.

- request/response API:
  - `POST /v1/sessions`
  - `POST /v1/sessions/:id/prompts`
  - `POST /v1/sessions/:id/cancel`
  - `GET /v1/sessions/:id`
- streaming API:
  - `GET /v1/sessions/:id/stream` via **SSE**

Relevant files:
- `src/http-server.ts`
- `src/http-client.ts`
- `src/frontend-events.ts`
- `src/service.ts`

### 2. ACP over stdio
Used in two places:

- the local CLI launches nanoboss's internal ACP server over stdio
- nanoboss launches downstream agents over stdio ACP

Relevant files:
- nanoboss ACP server:
  - `src/server.ts`
  - `cli.ts`
- downstream ACP client/runtime:
  - `src/acp-runtime.ts`
  - `src/call-agent.ts`
  - `src/default-session.ts`

### 3. Session MCP over stdio
Used so downstream agents can inspect durable nanoboss session cells and refs.

This is **not** ACP. It is an MCP server attached to downstream ACP sessions over stdio.

Relevant files:
- `src/session-mcp.ts`
- `src/session-mcp-stdio.ts`
- `src/mcp-attachment.ts`
- `src/session-store.ts`

---

## High-level picture

```mermaid
flowchart TD
  U[User] -->|local terminal| CLI[CLI\ncli.ts]
  U -->|HTTP requests| HTTPClient[HTTP client / UI\nsrc/http-client.ts]

  CLI -->|stdio ACP| ACPServer[nanoboss ACP server\nsrc/server.ts]
  HTTPClient -->|HTTP + SSE| HTTPServer[nanoboss HTTP/SSE server\nsrc/http-server.ts]

  ACPServer --> Service[NanobossService\nsrc/service.ts]
  HTTPServer --> Service

  Service --> Context[CommandContext / procedures\nsrc/context.ts]
  Context --> AgentRuntime[ACP runtime\nsrc/acp-runtime.ts]

  AgentRuntime -->|stdio ACP| Downstream[Downstream agent\nclaude / gemini / codex / copilot]
  Downstream -->|stdio MCP tool calls| SessionMcp[Session MCP stdio server\nsrc/session-mcp-stdio.ts]
  SessionMcp --> SessionStore[SessionStore\nsrc/session-store.ts]
```

---

## Default CLI path

When you run `nanoboss cli` without `--server-url`, the CLI connects to nanoboss over **HTTP/SSE** at `http://localhost:6502`.
For loopback URLs, the CLI first checks the server health/build id and will start
or restart the server automatically if it is missing or running a different
nanoboss commit.

```mermaid
sequenceDiagram
  participant User
  participant CLI as CLI
  participant Server as nanoboss HTTP server
  participant Service as NanobossService

  User->>CLI: start
  CLI->>Server: GET /v1/health
  alt missing or mismatched build
    CLI->>Server: POST /v1/admin/shutdown
    CLI->>Server: spawn matching server in background
  end
  User->>CLI: type prompt / command
  CLI->>Server: HTTP + SSE
  Server->>Service: createSession / prompt / cancel
  Service-->>ACP: session updates
  ACP-->>CLI: ACP session updates over stdio
  CLI-->>User: render output and tool traces
```

Relevant files:
- `cli.ts`
- `src/server.ts`
- `src/service.ts`

---

## HTTP/SSE frontend path

When you run `nanoboss http`, frontend clients talk to nanoboss over HTTP, and live updates come back over SSE.

```mermaid
sequenceDiagram
  participant User
  participant Client as HTTP client / UI
  participant HTTP as nanoboss HTTP server
  participant Service as NanobossService
  participant SSE as SSE stream

  User->>Client: send prompt
  Client->>HTTP: POST /v1/sessions/:id/prompts
  HTTP->>Service: prompt(...)
  Service-->>HTTP: accept request
  Client->>HTTP: GET /v1/sessions/:id/stream
  HTTP-->>SSE: event stream
  Service-->>SSE: run_started / chunks / tool updates / run_completed
  SSE-->>Client: frontend events
  Client-->>User: render updates
```

Relevant files:
- `src/http-server.ts`
- `src/http-client.ts`
- `src/frontend-events.ts`
- `src/service.ts`

---

## Downstream agent path

Nanoboss talks to downstream agents using **ACP over stdio**.

This path is used by:
- one-shot `callAgent(...)`
- persistent `/default` conversation sessions

```mermaid
flowchart LR
  Service[NanobossService / CommandContext] --> Runtime[ACP runtime\nsrc/acp-runtime.ts]
  Runtime -->|spawn + stdio ACP| Agent[Downstream agent]
```

Relevant files:
- `src/acp-runtime.ts`
- `src/call-agent.ts`
- `src/default-session.ts`
- `src/context.ts`

---

## Session MCP attachment path

When nanoboss launches a downstream ACP session, it also attaches a **stdio MCP server** so the downstream agent can inspect stored session state.

This is the current shape:

- downstream agent connection to nanoboss: **ACP over stdio**
- downstream agent connection to session tools: **MCP over stdio**

```mermaid
sequenceDiagram
  participant Ctx as CommandContext / default session
  participant ACP as ACP runtime
  participant Agent as Downstream agent
  participant MCP as Session MCP stdio server
  participant Store as SessionStore

  Ctx->>ACP: create/load downstream ACP session
  ACP->>Agent: stdio ACP session
  ACP->>Agent: attach MCP server config { type: stdio, command: nanoboss, args: [session-mcp, ...] }

  Agent->>MCP: tools/list
  MCP-->>Agent: session MCP tool definitions

  Agent->>MCP: tools/call top_level_runs / cell_get / ref_read ...
  MCP->>Store: read cells / refs
  Store-->>MCP: durable session data
  MCP-->>Agent: MCP tool result
```

Relevant files:
- `src/mcp-attachment.ts`
- `src/session-mcp-stdio.ts`
- `src/session-mcp.ts`
- `src/session-store.ts`

---

## What is *not* split today

### ACP is not HTTP + stdio in this repo
ACP is currently **stdio-only** in nanoboss.

- nanoboss ACP server: stdio only
- downstream agent ACP runtime: stdio only

There is no parallel HTTP ACP implementation in nanoboss.

### Session MCP is not stdio + HTTP anymore
Session MCP is currently **stdio-only**.

The unused HTTP session MCP transport was removed during the simplification pass.

---

## Transport matrix

| Layer | Protocol | Transport | Direction |
|---|---|---|---|
| Local CLI ↔ nanoboss | ACP | stdio | bidirectional |
| HTTP client ↔ nanoboss | nanoboss frontend API | HTTP | request/response |
| HTTP client ↔ nanoboss | frontend events | SSE | server → client |
| nanoboss ↔ downstream agent | ACP | stdio | bidirectional |
| downstream agent ↔ session tools | MCP | stdio | bidirectional |

---

## Mental model

A useful way to think about the stack is:

1. **Users talk to nanoboss** either through:
   - local CLI over **ACP/stdin-stdout**, or
   - remote HTTP API over **HTTP + SSE**
2. **Nanoboss talks to downstream agents** over **ACP/stdin-stdout**
3. **Downstream agents inspect nanoboss session state** through **MCP over stdio**

So the current architecture is intentionally mixed:

- **ACP for agent orchestration**
- **HTTP/SSE for frontend integration**
- **stdio MCP for session-state inspection**
