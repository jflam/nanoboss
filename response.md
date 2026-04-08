## Prompt Path: CLI → `/second-opinion` → Agent → Response

### 1. CLI Entry (`cli.ts`)

The CLI spawns the server (`src/server.ts`) as a child process. Communication uses **ACP (Agent Communication Protocol)** — JSON-RPC 2.0 over newline-delimited JSON (ndjson) on stdin/stdout.

```
CLI spawns server → ACP handshake (initialize, newSession) → REPL loop
```

When the user types `/second-opinion What is quantum computing?`, the REPL calls:
```ts
connection.prompt({ sessionId, prompt: [{ type: "text", text: line }] })
```

### 2. Server Dispatch (`src/server.ts`)

`Nanoboss.prompt()` receives the ACP prompt:
1. `extractPromptText()` pulls the raw text
2. `resolveCommand()` splits on `/` → `commandName = "second-opinion"`, `commandPrompt = "What is quantum computing?"`
3. Looks up the `Procedure` from the registry (loaded from `procedures/second-opinion.ts` at startup)
4. Creates a `CommandContextImpl` and calls `procedure.execute(commandPrompt, ctx)`

### 3. Second-Opinion Execution (`procedures/second-opinion.ts`)

Two sequential agent calls:

**Pass 1 — Claude Opus:**
```ts
ctx.callAgent(buildClaudePrompt(prompt), undefined, {
  agent: { provider: "claude", model: "opus" },
  stream: false,
})
```

**Pass 2 — Codex GPT-5.4 (critique):**
```ts
ctx.callAgent<CritiqueResult>(buildCritiquePrompt(prompt, firstPass.value), CritiqueResultType, {
  agent: { provider: "codex", model: "gpt-5.4" },
  stream: false,
})
```

The critique has a `TypeDescriptor` with a JSON schema and `validate()` — the agent response is parsed as JSON and validated. Up to 2 retries if parsing fails (with the error fed back in the prompt).

Finally: `ctx.print(renderSecondOpinion(...))` sends the formatted output back.

### 4. Context Layer (`src/context.ts` → `src/call-agent.ts`)

`CommandContextImpl.callAgent()`:
1. Emits `tool_call` session update upstream (status: `"pending"`)
2. Calls `callAgent()` from `call-agent.ts`
3. On completion, emits `tool_call_update` (status: `"completed"` or `"failed"`)

`callAgent()` → `runAcpPrompt()`:
1. Resolves config per provider (e.g., `claude-code-acp`, `codex-acp`)
2. **Spawns the downstream agent as a child process**
3. Wraps its stdio in an ACP stream
4. ACP handshake: `initialize()` → `newSession()` → optionally `setSessionModel()`
5. `connection.prompt()` — sends the actual prompt
6. Collects `agent_message_chunk` text into a `raw` string
7. Returns `{ raw, logFile, updates, durationMs }`
8. Kills the child process in `finally`

### 5. Response Path Back

```
downstream agent → agent_message_chunk updates → raw text accumulated
    → returned to callAgent() in context.ts
    → tool_call_update emitted upstream
    → ctx.print() emits agent_message_chunk upstream
    → QueuedSessionUpdateEmitter serializes over ACP ndjson
    → CLI's CliClient.sessionUpdate() writes to process.stdout
```

### ACP Message Flow

```
CLI                              Server                           Downstream Agent
 |--- initialize ─────────────→|                                       |
 |←── agentInfo ────────────────|                                       |
 |--- newSession ──────────────→|                                       |
 |←── available_commands ───────|                                       |
 |←── { sessionId } ───────────|                                       |
 |--- prompt ──────────────────→|                                       |
 |                               |── spawn claude-code-acp ───────────→|
 |                               |── initialize ──────────────────────→|
 |                               |── newSession ──────────────────────→|
 |                               |── setSessionModel("opus") ────────→|
 |                               |── prompt ──────────────────────────→|
 |←── tool_call (pending) ──────|                                       |
 |                               |←── agent_message_chunk(s) ──────────|
 |                               |←── { stopReason: "end_turn" } ──────|
 |←── tool_call_update (done) ──|                                       |
 |                               |── [repeats for codex-acp] ─────────→|
 |←── tool_call (pending) ──────|                                       |
 |←── tool_call_update (done) ──|                                       |
 |←── agent_message_chunk ──────|   (ctx.print output)                  |
 |←── available_commands ───────|                                       |
 |←── { stopReason: "end_turn" }|                                       |
```

---

## What's Missing from the ACP Output

Several gaps in what nanoboss emits:

| Gap | Detail |
|-----|--------|
| **`rawOutput` lacks actual content** | On `tool_call_update` completion, `rawOutput` is `{ durationMs, logFile }` — **not** the agent's response text. Clients can't inspect what the agent returned without reading the log file. |
| **`kind` always `"other"`** | Every `tool_call` uses `kind: "other"`. The ACP spec supports richer kinds (`read`, `write`, `bash`, etc.) that enable better client UI. |
| **No `content` on tool calls** | The `ToolCall` type supports a `content` field (text, diffs, terminals) that's never populated. |
| **No `locations` on tool calls** | The `ToolCall.locations` field (for follow-along file tracking) is never set. |
| **No `in_progress` status** | Tool calls jump from `"pending"` directly to `"completed"`/`"failed"` — no intermediate `"in_progress"` state. |
| **Downstream tool calls invisible when `stream: false`** | `/second-opinion` suppresses all intermediate updates from Claude/Codex. The upstream client has zero visibility into what the downstream agents are doing (their own tool calls, reasoning, etc.). |
| **No `PromptResponse` metadata** | The server always returns `{ stopReason: "end_turn" }` with no usage stats, model info, or token counts. |
| **Downstream stderr not surfaced** | Agent stderr goes to transcript log files only — never forwarded as ACP updates. |

The most impactful gap is probably that **`rawOutput` doesn't include the actual response content** — a client wanting to build a richer UI (showing what each agent said) would need to parse log files rather than getting it directly from the ACP stream.

Codex critique (gpt-5.4)
Verdict: mixed
The answer gets the broad control flow mostly right, but it blurs two different ACP layers and overstates several "missing from ACP output" claims. The biggest misses are that the visible `tool_call` events are synthetic wrappers created by `CommandContextImpl.callAgent()`, each downstream agent runs in a fresh subprocess/session with no carried chat history, and some supposed ACP gaps are really just omissions in this implementation's wrapper events or filtering behavior.

Issues
- It does not clearly distinguish the two kinds of tool calls: the synthetic wrapper `tool_call`/`tool_call_update` events emitted by `src/context.ts` around each `ctx.callAgent()`, versus real tool calls emitted by the downstream ACP child. That distinction is central to the user's question about how tool calls are generated.
- Several "missing from ACP output" claims are overgeneralized. `kind`, `content`, `locations`, and `in_progress` are missing from this repo's wrapper tool calls, but not from ACP itself, and not necessarily from forwarded downstream tool calls when streaming is enabled.
- It misses a major control-flow fact: `/second-opinion` sets `stream: false` for both downstream calls, so the CLI does not see downstream `agent_message_chunk`, `tool_call`, or `tool_call_update` events at all. It only sees two synthetic wrapper tool calls and the final rendered output.
- It omits that every `ctx.callAgent()` spawns a fresh child process and a fresh ACP session. There is no downstream conversation continuity between the Claude pass and the Codex critique pass, and server-side session state only stores `cwd` and an abort controller.
- It says retries happen if parsing fails, but the typed `callAgent()` path also retries on schema-validation failure, not just JSON parse failure.
- The PromptResponse criticism is sloppy. In this ACP SDK, `PromptResponse` has `stopReason` plus optional `usage` and `userMessageId`; claiming missing `model info` is not grounded in the protocol type.
- It misses permission flow entirely. Downstream `requestPermission` calls are auto-approved inside `runAcpPrompt()` and logged to transcript, not surfaced back to the top-level CLI ACP stream.
- It misses another real filtering gap: even when streaming is enabled, `src/context.ts` forwards only downstream `agent_message_chunk`, `tool_call`, and `tool_call_update`. Other ACP updates such as `agent_thought_chunk`, `plan`, and `available_commands_update` are dropped.

Revised answer
There are two ACP hops here, not one:

1. CLI to nanoboss
- `cli.ts` spawns `bun run src/server.ts`, wraps stdio with ACP ndjson, then does `initialize()` and `newSession()` once.
- Each REPL line is sent with `connection.prompt({ sessionId, prompt: [{ type: 'text', text: line }] })`.
- The CLI prints `agent_message_chunk` text to stdout. It prints `tool_call` lines to stderr.

2. nanoboss dispatches `/second-opinion`
- In `src/server.ts`, `prompt()` joins the incoming text blocks, parses `/second-opinion ...` into `{ commandName, commandPrompt }`, looks up the procedure in the registry, and calls `procedure.execute(commandPrompt, ctx)`.
- Important context: the server session is almost stateless. `SessionState` only keeps `cwd` and an `AbortController`; it does not store conversation history.

3. `/second-opinion` does two separate downstream agent calls
- `procedures/second-opinion.ts` calls `ctx.callAgent()` twice, sequentially, both with `stream: false`.
- First pass: Claude with provider `claude`, model `opus`.
- Second pass: Codex with provider `codex`, model `gpt-5.4`, using the `CritiqueResultType` schema.
- The typed second pass goes through `src/call-agent.ts`, which appends schema instructions to the prompt and retries up to 2 times if the response cannot be parsed as valid JSON or fails schema validation.

4. How the ACP tool calls are generated
- The top-level `tool_call` events are not produced automatically by ACP, and they are not the child agent's own tool calls.
- They are synthesized by `CommandContextImpl.callAgent()` in `src/context.ts`:
  - before the child call, it emits a `tool_call` with a title like `callAgent [claude:opus]: ...`, `kind: 'other'`, `status: 'pending'`, and `rawInput`
  - after the child finishes, it emits a `tool_call_update` with `status: 'completed'` or `failed`
- So, from the CLI's point of view, `callAgent()` itself is being represented as a tool.

5. What happens inside each `ctx.callAgent()`
- `src/call-agent.ts` resolves the downstream config, spawns `claude-code-acp` or `codex-acp`, opens a brand-new ACP client connection to that child, runs `initialize()`, `newSession()`, optionally `unstable_setSessionModel()`, then sends `prompt()`.
- Each downstream call is a fresh subprocess and a fresh ACP session. No prior downstream chat history is reused automatically.
- Downstream `requestPermission` calls are auto-approved inside `runAcpPrompt()` by choosing the first `allow*` option. Those approvals are logged to the transcript file, not surfaced upstream.

6. How the response comes back
- `runAcpPrompt()` accumulates downstream `agent_message_chunk` text into a local `raw` string.
- It also logs every downstream session update and stderr to a transcript file.
- Because `/second-opinion` uses `stream: false`, downstream `agent_message_chunk`, `tool_call`, and `tool_call_update` notifications are not forwarded to the upstream CLI.
- After both child calls finish, `renderSecondOpinion(...)` builds the combined output, `ctx.print()` emits it as an upstream `agent_message_chunk`, and the CLI prints it.

7. What is missing from the current upstream ACP output
- The wrapper `tool_call_update.rawOutput` does not include the actual downstream response text. On success it only includes `durationMs` and `logFile`. The raw text is not lost, but it is only available internally as `AgentResult.raw` and in the transcript log.
- Wrapper tool calls never emit `in_progress`.
- Wrapper tool calls always use `kind: 'other'` and never set `content` or `locations`.
- The top-level `PromptResponse` always returns only `stopReason: 'end_turn'`; it does not populate optional `usage` or `userMessageId`.
- With `/second-opinion` specifically, the upstream client sees none of the downstream agents' own message chunks, tool calls, permission activity, or stderr because both calls run with `stream: false`.
- Even when streaming is enabled elsewhere, nanoboss only forwards downstream `agent_message_chunk`, `tool_call`, and `tool_call_update`; it drops other ACP update types like `agent_thought_chunk`, `plan`, and `available_commands_update`.

The shortest accurate summary is: the CLI sends one ACP prompt to nanoboss; nanoboss resolves `/second-opinion`; that command makes two fresh downstream ACP prompt turns in child processes; nanoboss wraps each child call in its own synthetic ACP `tool_call`; then it prints the final combined result back to the CLI.
