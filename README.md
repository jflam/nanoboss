# nanoboss

Nanoboss is a procedure-oriented runtime for agent workflows. Instead of
centering one generic inner agent loop, it lets workflow code decide
continuity, checkpoints, validation, recovery, and what counts as "done".

## Prerequisites

You need all of the following before nanoboss will be useful:

- [Bun](https://bun.sh/) installed locally
- this repo checked out if you are running from source
- at least one supported downstream agent stack installed
- that agent authenticated with its own CLI before you start nanoboss

Nanoboss does **not** perform provider login for you. `nanoboss doctor` checks
installation and transport readiness, and `nanoboss doctor --register`
configures MCP. Neither command authenticates Claude, Codex, Gemini, or
Copilot on your behalf.

### Supported downstream agents

| Provider | What nanoboss launches | Extra requirement | Auth note |
|---|---|---|---|
| Copilot | `copilot --acp --allow-all-tools` | none beyond the Copilot CLI | complete the Copilot CLI sign-in flow first |
| Gemini | `gemini --acp` | none beyond the Gemini CLI | complete the Gemini CLI auth flow first |
| Claude | `claude-code-acp` | install the Claude CLI and the Zed ACP broker package `@zed-industries/claude-code-acp` | authenticate the Claude CLI first |
| Codex | `codex-acp` | install the Codex CLI and the Zed ACP broker package `@zed-industries/codex-acp` | authenticate the Codex CLI first |

If you want Claude or Codex as downstream agents, install the ACP broker
commands globally so `claude-code-acp` / `codex-acp` are on your `PATH`:

```bash
npm install -g @zed-industries/claude-code-acp @zed-industries/codex-acp
```

## Install dependencies

From the repo root:

```bash
bun install
```

## Build and install the `nanoboss` binary

The build command is:

```bash
bun run build
```

This compiles the standalone `nanoboss` binary and installs it onto your
`PATH`. The build output also reports the final emitted binary size plus an
estimated breakdown of the embedded bundle versus the Bun runtime, including
top bundled app areas and dependencies.

By default the build installs `nanoboss` into the first suitable user-owned
PATH location, preferring `~/.local/bin`, then `~/bin`, then `~/.bun/bin`.

It also leaves the compiled artifact at:

```bash
dist/nanoboss
```

To override the install location:

```bash
NANOBOSS_INSTALL_DIR=~/bin bun run build
```

Each build embeds the current git commit hash. On startup, the server and CLI
print a banner like `nanoboss-<commit>`.

During source-tree development you can also run nanoboss without building:

```bash
bun run nanoboss --help
```

## First-time setup

The shortest reliable setup flow is:

1. Install repo dependencies with `bun install`.
2. Build nanoboss with `bun run build` if you want an installed `nanoboss`
   binary. For source-tree development, `bun run nanoboss ...` is fine.
3. Install and authenticate at least one downstream agent CLI.
4. Run the doctor command to inspect what nanoboss can currently see:

   ```bash
   nanoboss doctor
   ```

   or from source:

   ```bash
   bun run nanoboss doctor
   ```

5. Register the global `nanoboss` MCP server for supported agents:

   ```bash
   nanoboss doctor --register
   ```

   or from source:

   ```bash
   bun run nanoboss doctor --register
   ```

6. Start the CLI:

   ```bash
   nanoboss cli
   ```

   or from source:

   ```bash
   bun run nanoboss cli
   ```

7. Use `/model` inside the CLI to inspect or change the default provider/model.

### What `doctor` and `doctor --register` actually do

`nanoboss doctor` prints a table showing:

- which agent CLIs are installed
- whether their ACP path is usable
- whether the standard MCP setup path is available

Typical output looks like:

```text
Agents                    ACP                     Global MCP
  Claude Code              zed ACP broker ...      [setup] nanoboss doctor --register
  Codex                    zed ACP broker ...      [setup] nanoboss doctor --register
  Gemini CLI               native ...              [setup] nanoboss doctor --register
  Copilot CLI              native ...              [setup] nanoboss doctor --register
```

`nanoboss doctor --register` configures one globally registered stdio MCP
server named `nanoboss` and repairs stale or broken registrations. It covers:

- Claude Code via `claude mcp add`
- Codex via `codex mcp add`
- Gemini CLI by writing `~/.gemini/settings.json`
- Copilot CLI by writing `~/.copilot/mcp-config.json`

This is the standard way to make durable nanoboss session tools available to
downstream agents. Run it again whenever you:

- switch from source-tree execution to an installed binary
- rebuild/reinstall nanoboss and want agents to point at the latest command
- suspect your MCP registration is stale or broken

The registered command depends on how you invoke registration:

- if you run `nanoboss doctor --register`, agents will call the installed
  `nanoboss` binary
- if you run `bun run nanoboss doctor --register`, agents will call the source
  checkout through Bun

## Choosing and configuring the downstream agent

If you do nothing, nanoboss defaults to Copilot:

```text
copilot --acp --allow-all-tools
```

You can choose the default agent in three ways:

1. Interactively in the TTY CLI with `/model`
2. Explicitly in a session with `/model <provider> <model>`
3. Through environment variables

Examples:

```bash
/model
/model gemini
/model gemini gemini-2.5-pro
/model copilot gpt-5.4/xhigh
```

Environment-variable overrides:

```bash
NANOBOSS_AGENT_CMD=gemini \
NANOBOSS_AGENT_ARGS='["--acp"]' \
bun run nanoboss cli
```

```bash
NANOBOSS_AGENT_CMD=claude-code-acp \
NANOBOSS_AGENT_ARGS='[]' \
bun run nanoboss cli
```

```bash
NANOBOSS_AGENT_CMD=codex-acp \
NANOBOSS_AGENT_ARGS='[]' \
bun run nanoboss cli
```

To set a default model for the startup banner and downstream agent config, use:

```bash
NANOBOSS_AGENT_MODEL=gpt-5.4/xhigh
```

With that set, the CLI banner looks like:

```text
nanoboss-<commit> copilot/gpt-5.4/x-high
```

If no explicit environment override is present, nanoboss can also reuse the
persisted default selection saved by the TTY `/model` picker in:

```text
~/.nanoboss/settings.json
```

## Procedure loading

At startup, nanoboss loads built-in procedure packages from `./packages` in the
source tree and also loads additional disk procedures from these locations by
default:

- `./.nanoboss/procedures` in the current repository root
- `~/.nanoboss/procedures`

Those procedure roots contain entrypoint files such as
`.nanoboss/procedures/review.ts` or `.nanoboss/procedures/kb/answer.ts`.
Nanoboss recursively discovers `.ts` files that export a default procedure, so
helper modules can live alongside procedure entrypoints without being
registered as slash commands.

See [`docs/procedure-packages.md`](docs/procedure-packages.md) for the built-in
and disk procedure layout, discovery rules, and manifest expectations.

The profile directory is the default place for user-defined procedures. When
`/create` runs inside a git repository, it writes under that repo's
`.nanoboss/procedures/`. Otherwise it writes under `~/.nanoboss/procedures/`.
Unscoped procedures persist as `procedures/<name>.ts`; scoped procedures persist
as `procedures/<package>/<leaf>.ts`.

Built-in procedures are exposed as slash commands and include the
knowledge-base workflow:

- `/kb/ingest`
- `/kb/compile-source`
- `/kb/compile-concepts`
- `/kb/link`
- `/kb/render`
- `/kb/health`
- `/kb/refresh`
- `/kb/answer`

If you need to disable runtime disk command loading, set:

```bash
NANOBOSS_LOAD_DISK_COMMANDS=0
```

## Unified entrypoint

Everything goes through a single `nanoboss` entrypoint.

## Architecture

See [`docs/architecture.md`](docs/architecture.md) for a transport-level overview of:

- local CLI over ACP/stdin-stdout
- HTTP/SSE frontend mode
- downstream agent ACP sessions
- global nanoboss MCP over stdio

## Commands

Launch the HTTP/SSE server:

```bash
bun run nanoboss http
```

Launch the CLI frontend. By default it starts an owned private loopback HTTP/SSE
server on an ephemeral port for that terminal session. Use `nanoboss http` when
you want an explicit shared server instead.

When you run the installed `nanoboss` binary from the nanoboss repo working
copy, the CLI also warns if the executable looks older than the current
build-relevant files in that working tree, so it is easier to notice when you
forgot to rebuild after local changes:

```bash
bun run nanoboss cli
```

Override the server URL if needed:

```bash
bun run nanoboss cli --server-url http://localhost:6503
```

Passing `--server-url` is connect-only: nanoboss validates the target server and
will never kill or restart it for you. Omit `--server-url` to get the default
private local server lifecycle.

Inspect agent health and register the global nanoboss MCP server if needed:

```bash
bun run nanoboss doctor
bun run nanoboss doctor --register
```

The internal stdio ACP server is still available for local CLI mode:

```bash
bun run nanoboss acp-server
```

Nanoboss standardizes on one globally registered `nanoboss` MCP stdio server across Claude, Gemini, Codex, and Copilot.

Tool call progress lines are shown by default. Hide them with:

```bash
bun run nanoboss cli --no-tool-calls
```

By default the local REPL path spawns `copilot --acp --allow-all-tools`. In that default path,
nanoboss does not set a model, so the downstream Copilot CLI uses its own
default model unless a procedure selects one explicitly. Override the downstream
agent with `NANOBOSS_AGENT_CMD` and `NANOBOSS_AGENT_ARGS` if needed.

To set a default model for the startup banner and downstream agent config, use:

```bash
NANOBOSS_AGENT_MODEL=gpt-5.4/xhigh
```

With that set, the CLI banner looks like:

```text
nanoboss-<commit> copilot/gpt-5.4/x-high
```

To lint the repository:

```bash
bun run lint
```

## Testing

Run the fast local test suite:

```bash
bun run test
```

This runs a compact wrapper around the unit test suite and emits `.` for pass, `S` for skip, and `F` for fail,
then prints detailed failure output only when tests fail. It targets the root `tests/unit` suite only; it does
not run package-local tests under `packages/*/tests`.

Run unit tests only:

```bash
bun run test:unit
```

This runs the compact test wrapper against `tests/unit`.

Run every test file with raw `bun test` discovery:

```bash
bun run test:raw
```

This includes root unit tests, root e2e tests, and package-local tests discovered under `packages/*/tests`.
Running literal `bun test` at the repo root has the same discovery behavior.

Run end-to-end tests with the default gating behavior:

```bash
bun run test:e2e
```

This runs the compact test wrapper against `tests/e2e`. Real-agent tests are present in that directory, but they remain skipped
unless `NANOBOSS_RUN_E2E=1` is enabled.

Run the full real-agent end-to-end suite:

```bash
bun run test:e2e:real
```

This runs `NANOBOSS_RUN_E2E=1 bun run scripts/compact-test.ts tests/e2e` and exercises the real downstream agents.

Run the `/default` multi-turn history real-agent coverage only:

```bash
NANOBOSS_RUN_E2E=1 bun run scripts/compact-test.ts tests/e2e/default-history-agents.test.ts
```

That file contains 4 independent tests:

- Claude
- Gemini
- Codex
- Copilot

Run a single real-agent `/default` history test by name:

```bash
NANOBOSS_RUN_E2E=1 bun run scripts/compact-test.ts tests/e2e/default-history-agents.test.ts --test-name-pattern claude
```

Replace `claude` with `gemini`, `codex`, or `copilot` as needed.

If you need Bun's native reporter output for debugging, run `bun run test:raw`.

Typed downstream agent outputs should use `jsonType(...)` from `@nanoboss/procedure-sdk` with concrete `typia`
inputs, for example `jsonType<Result>(typia.json.schema<Result>(), typia.createValidate<Result>())`,
instead of handwritten schema/validator descriptors. Bun preload for the typia transform is configured
in `bunfig.toml`.

## Package Development

Each workspace package can be developed in isolation from its own directory:

```bash
cd packages/<name> && bun test
cd packages/<name> && bun run typecheck
```

From the repo root, `bun run test:packages` and `bun run typecheck:packages`
fan those commands out across every package. `bun run check:precommit` now runs
both package fan-out commands alongside the existing root lint, typecheck,
knip, and root test checks.

Use these commands when you want specific scopes:

- `bun run test`
  Root compact unit suite only.
- `bun run test:raw` or `bun test`
  All discoverable Bun tests in the repo, including package tests.
- `bun run test:packages`
  Each package's declared `test` script, run package-by-package.

Cross-package imports are governed by the `ALLOWED_LAYERING` table in
`tests/unit/package-dependency-direction.test.ts`. That test enforces two
rules:

- every `@nanoboss/*` import used by a package must be declared in that
  package's `dependencies`
- every declared workspace dependency must appear in that package's allowed
  layering entry

Current allowed layering:

```text
contracts             -> (none)
app-support           -> (none)
procedure-sdk         -> contracts
store                 -> app-support, contracts, procedure-sdk
agent-acp             -> contracts, procedure-sdk, store
procedure-catalog     -> app-support, procedure-sdk
procedure-engine      -> agent-acp, contracts, procedure-catalog, procedure-sdk, store
app-runtime           -> agent-acp, app-support, contracts, procedure-catalog, procedure-engine, procedure-sdk, store
adapters-mcp          -> app-runtime, app-support, contracts, procedure-sdk, store
adapters-http         -> agent-acp, app-runtime, app-support, procedure-sdk
adapters-tui          -> adapters-http, agent-acp, app-support, contracts, procedure-engine, procedure-sdk, store
adapters-acp-server   -> agent-acp, adapters-mcp, app-runtime, app-support, contracts, procedure-engine
```

To add a new `@nanoboss/*` dependency edge, update both the consuming
package's `dependencies` in `packages/<name>/package.json` and that package's
entry in `ALLOWED_LAYERING`, then run
`bun run test:unit tests/unit/package-dependency-direction.test.ts` or
`bun run check:precommit`
to prove the new edge is intentional and still acyclic.
