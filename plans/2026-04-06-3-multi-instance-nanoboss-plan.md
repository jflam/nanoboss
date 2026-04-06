# 2026-04-06 multi-instance nanoboss plan

## Goal

Make it safe to run multiple nanoboss instances in parallel across:

- separate git clones
- separate workspaces
- separate terminals
- separate explicit HTTP servers

without restart wars, wrong-command bleed, or hidden startup failures.

## Recommendation in one sentence

`nanoboss cli` and `nanoboss resume` should stop depending on one implicit global `http://localhost:6502` daemon and instead launch an owned **private loopback HTTP/SSE server** on a per-launch ephemeral port by default, while `nanoboss http` remains the explicit shared/server mode.

---

## Why this plan is needed

The current failure was not just a one-off timeout. It exposed several architectural smells:

1. **Default frontend transport is globally singleton by accident**
   - `cli` and `resume` default to `http://localhost:6502`
   - local loopback servers are auto-restarted if the build commit does not match

2. **Server identity is too weak**
   - health/build matching is currently based on `buildCommit`
   - that does **not** distinguish:
     - different git clones
     - different checked-out branches with the same built binary
     - different repo-local `commands/*.ts`
     - different environment/config surfaces

3. **A shared server loads repo-local commands from its own process cwd**
   - `NanobossService.create()` builds one registry at process startup
   - `registry.loadFromDisk()` reads from `process.cwd()`
   - if one server is reused across different worktrees, it can expose the wrong command set

4. **Server startup failures are hidden**
   - the background child is spawned detached with ignored stdio
   - command-load/boot errors collapse into a generic startup timeout

5. **There are still singleton local state files**
   - `~/.nanoboss/current-session.json` is one global pointer
   - that is not a strong model for multiple concurrent local frontends

The timeout you hit was just the visible symptom. The bigger issue is that the current local frontend path behaves like a global daemon even though nanoboss is often used as a repo-local tool.

---

## Design principles

### 1) Default local CLI should be private, not shared

The common case is:

- one user
- one terminal
- one repo checkout
- one local TUI

That path does **not** need a globally shared fixed-port server.

### 2) Shared HTTP should be explicit

If a user wants a stable shared endpoint, that should be an intentional `nanoboss http` workflow, not an implicit side effect of `nanoboss cli`.

### 3) External attach should never destroy what it did not create

If the user passes `--server-url`, nanoboss should treat that as an explicit attach target, not as permission to kill/restart that server.

### 4) Workspace-specific behavior must be scoped by workspace

Repo-local commands, plans, and behavior should be derived from the session/workspace being served, not silently inherited from whichever process happened to bind first.

### 5) Startup failures must surface real diagnostics

If a private server cannot start, the user should see the child error directly instead of a vague timeout.

---

## Target architecture

We should separate frontend connection modes into three clear categories.

### A. Private local mode (new default for `cli` and `resume`)

Behavior:

- parent CLI process spawns a child nanoboss HTTP server
- child binds to loopback only
- child uses an ephemeral port
- parent waits for a startup handshake
- parent connects to that exact server URL
- parent owns the child lifecycle and terminates it on exit

Properties:

- no global fixed port collision
- no cross-clone restart war
- per-launch cwd scoping is natural
- startup stderr can be captured and shown

### B. External attach mode (`--server-url ...`)

Behavior:

- connect to the provided URL only
- do not auto-restart it
- do not auto-kill it
- validate compatibility and warn/error clearly if the server is not suitable

Properties:

- predictable
- safe for operator-managed/shared servers
- safe for future remote frontends

### C. Explicit shared server mode (`nanoboss http`)

Behavior:

- user intentionally starts a long-lived server
- port is operator-selected or stable
- multi-workspace safety depends on stronger workspace scoping

Properties:

- good for automation and alternate frontends
- should remain supported
- should not be the implicit default path for local TUI anymore

---

## Proposed implementation plan

## Phase 1: introduce explicit frontend connection modes

### Goal

Make the local CLI path stop assuming one global server.

### Recommendation

Change semantics to:

- `nanoboss cli` with no `--server-url` → start a **private** local server
- `nanoboss resume` with no `--server-url` → start a **private** local server
- `nanoboss cli --server-url ...` → **attach only**
- `nanoboss resume --server-url ...` → **attach only**
- `nanoboss http` → explicit shared server

### Important behavior change

Remove the implicit “loopback URL means nanoboss may kill/restart whatever is there” behavior from the default CLI attach path.

That restart behavior is exactly what causes cross-instance interference.

### Likely files

- `cli.ts`
- `resume.ts`
- `src/options/frontend-connection.ts`
- `src/http/server-supervisor.ts`
- `README.md`
- `docs/architecture.md`

---

## Phase 2: add a private server launcher with real startup handshake

### Goal

Start a local child server reliably and surface real errors.

### Recommendation

Add a dedicated helper for CLI-owned private servers, separate from the current detached background supervisor.

Suggested behavior:

- spawn `nanoboss http` as a child process
- bind loopback only
- request port `0` if Bun supports it cleanly; otherwise reserve a free local port in the launcher
- keep stdout/stderr piped during startup
- wait for a machine-readable readiness signal from the child
- if startup fails, print child stderr directly
- once ready, run the TUI against the returned URL
- on TUI exit, terminate the child in `finally`

### Strong recommendation

Do **not** detach the private child.

The private server should have a single owner: the local CLI frontend that started it.

### Suggested readiness payload

Have the child emit a structured line such as:

```text
NANOBOSS_SERVER_READY {"baseUrl":"http://127.0.0.1:6517","pid":12345,"buildLabel":"nanoboss-...","mode":"private"}
```

That avoids polling an unknown port and gives the parent deterministic startup.

### Optional hardening

Include a random auth token in the readiness payload and require that token on subsequent frontend requests. Loopback-only transport is probably enough for v1, but a token is a nice defense-in-depth option.

### Likely files

- new local launcher helper, e.g. `src/http/private-server.ts`
- `src/http/server.ts`
- `src/tui/run.ts`
- `cli.ts`
- `resume.ts`

---

## Phase 3: strengthen server identity and make attach non-destructive

### Goal

Prevent accidental cross-attach and wrong-worktree reuse.

### Recommendation

Expand server identity beyond just `buildCommit`.

Suggested `/v1/health` additions:

- `mode`: `private` | `shared`
- `pid`
- `buildCommit`
- `buildLabel`
- `cwd`
- `repoRoot` if detectable
- `commandsFingerprint` for disk-loaded commands

### New attach rules

#### Private mode

The parent already owns the child, so no global compatibility check is needed beyond startup success.

#### External/shared attach mode

If the client attaches to `--server-url`, nanoboss should:

- fetch health
- compare identity
- warn or error on mismatch
- **never** auto-restart the target

### Interim safety rule before per-session registries land

Until the server is truly workspace-multiplex-safe, external/shared attach should reject or loudly warn when:

- the server repo root differs from the client cwd/worktree root
- or the server command fingerprint differs from what the client expects

This is a deliberate guardrail against silent wrong-command bleed.

### Likely files

- `src/http/server.ts`
- `src/http/client.ts`
- `src/http/server-supervisor.ts`
- `src/core/build-info.ts`
- maybe a new server identity helper

---

## Phase 4: decouple procedure registries from process cwd

### Goal

Make one nanoboss server able to serve multiple workspaces correctly, not just multiple sessions from one cwd.

### Current problem

`NanobossService.create()` currently loads disk commands once at process startup using a registry rooted at `process.cwd()`. That means command availability is effectively a process-global property.

That is incompatible with a truly shared multi-workspace HTTP server.

### Recommendation

Refactor command loading so that:

- builtins stay global
- repo-local/profile disk commands are resolved per session/workspace key
- session descriptors use the command set for that session’s cwd
- procedure execution uses the matching per-session registry

### Good implementation direction

Cache registries by a workspace key such as:

- repo root if inside a repo
- otherwise absolute cwd

This gives:

- one registry per workspace
- reuse within that workspace
- isolation across clones/worktrees

### Extra hardening

If repo-local command loading fails for one workspace:

- do not crash the whole HTTP server
- degrade that workspace to builtins + warning state
- surface the command-load error clearly in session status or local status lines

That would have made the original failure far more understandable.

### Likely files

- `src/core/service.ts`
- `src/procedure/registry.ts`
- `src/http/frontend-events.ts`
- maybe new workspace/registry cache helpers

---

## Phase 5: clean up singleton local metadata

### Goal

Remove hidden local singletons that do not model concurrent frontends well.

### Current problem

`~/.nanoboss/current-session.json` is one global “current” pointer.

That is weak when multiple local CLIs are active. It can only point at one session at a time, even though several may be active and valid.

### Recommendation

Replace the singleton pointer with something keyed by workspace, for example:

- `current-sessions.json` keyed by repo root / cwd hash
- or eliminate the singleton pointer entirely and derive “most recent for cwd” from session metadata

### Direction

For the multi-instance effort, a per-workspace current-session index is enough. It does not need to solve every resume UX nuance on day one.

### Likely files

- `src/session/repository.ts`
- `resume.ts`
- tests covering stored session resolution

---

## Phase 6: testing and failure-mode coverage

### Goal

Prove that parallel nanoboss runs do not interfere.

### Add tests for

1. **Default CLI private mode**
   - no `--server-url` launches a private local server
   - the chosen port is not the fixed default singleton port

2. **External attach is non-destructive**
   - `--server-url http://localhost:...` does not restart/kill an existing server

3. **Parallel clones**
   - start nanoboss from two different checkout dirs
   - both TUI flows can run at once
   - neither restarts the other

4. **Startup diagnostics**
   - if child startup fails, the surfaced error includes child stderr/root cause
   - not just `Timed out waiting for nanoboss HTTP server`

5. **Workspace command isolation**
   - distinct workspaces expose the correct command sets
   - broken commands in one workspace do not take down another workspace/server

6. **Resume behavior**
   - `resume` can start a fresh private server and reopen a stored session cleanly

7. **Current-session isolation**
   - concurrent sessions from different cwd values do not stomp one another’s default resume target

### Likely files

- `tests/unit/http-server-supervisor.test.ts`
- `tests/e2e/http-server-supervisor.test.ts`
- CLI/resume option tests
- new integration coverage for private server launch and parallel workspaces

---

## Phase 7: documentation and UX cleanup

### Goal

Make the new model obvious to users.

### Documentation updates

Update docs/help text so they clearly say:

- `cli`/`resume` default to a private loopback server
- `http` is the explicit shared-server mode
- `--server-url` means attach to an existing server
- shared servers are intentionally separate from the default local TUI lifecycle

### Suggested help-text language

Instead of:

- “connects to `http://localhost:6502` by default”

move to something like:

- “starts a private local nanoboss server by default”
- “use `--server-url` to attach to an existing server”
- “use `nanoboss http` to run an explicit shared server”

---

## Rollout order

### Minimal fix that addresses the current pain

1. Phase 1: connection modes
2. Phase 2: private server launcher + startup handshake
3. Phase 3: non-destructive attach semantics + stronger health identity

That is enough to stop the worst restart-war behavior.

### Full multi-instance hardening

4. Phase 4: per-workspace registries
5. Phase 5: current-session cleanup
6. Phase 6: tests
7. Phase 7: docs/help text

---

## Non-goals for the first pass

These are useful, but should not block the first fix:

- remote/private server auth beyond loopback-only binding
- multi-client fan-out to the same private local server
- preserving private server lifetime after the owning TUI exits
- redesigning the global nanoboss MCP transport

The first pass should focus on removing the accidental singleton behavior from local CLI usage.

---

## Success criteria

We should consider this effort successful when all of the following are true:

1. Running `nanoboss` in one checkout no longer restarts or breaks nanoboss in another checkout by default.
2. Default local CLI usage no longer depends on one global fixed localhost port.
3. Passing `--server-url` never implicitly kills/restarts the target server.
4. Startup failures show the real child error instead of a generic timeout.
5. Explicit shared HTTP mode remains available for automation.
6. Shared servers either:
   - correctly isolate workspaces, or
   - reject unsafe cross-workspace reuse loudly until that isolation lands.

---

## Bottom line

The right mental model is:

- **local TUI** → private owned child server
- **shared/automation HTTP** → explicit `nanoboss http`
- **external URL** → attach only, never auto-restart

That keeps the current HTTP/SSE frontend architecture, but removes the accidental global-daemon behavior that is causing the multi-instance problems.
