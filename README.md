# nanoboss

To install dependencies:

```bash
bun install
```

## Unified entrypoint

Everything now goes through a single `nanoboss` entrypoint.

During development:

```bash
bun run nanoboss --help
```

## Build the `nanoboss` binary

The build command is:

```bash
bun run build
```

This compiles the standalone `nanoboss` binary and installs it onto your `PATH`.
The build output also reports the final emitted binary size plus an estimated
breakdown of the embedded bundle versus the Bun runtime, including top bundled
app areas and dependencies.

By default the build installs `nanoboss` into the first suitable user-owned PATH
location, preferring `~/.local/bin`, then `~/bin`, then `~/.bun/bin`.

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

At startup, nanoboss loads built-in procedure packages from `./packages` in the
source tree and also loads additional disk procedures from these locations by
default:

- `./.nanoboss/procedures` in the current repository root
- `~/.nanoboss/procedures`

Those procedure roots contain entrypoint files such as
`.nanoboss/procedures/review.ts` or `.nanoboss/procedures/kb/answer.ts`;
nanoboss recursively discovers `.ts` files that export a default procedure, so
helper modules can live alongside procedure entrypoints without being
registered as slash commands.

See [`docs/procedure-packages.md`](docs/procedure-packages.md) for the built-in
and disk procedure layout, discovery rules, and manifest expectations.

The profile directory is the default place for user-defined procedures. When
`/create` runs inside a git repository, it writes under that repo's
`.nanoboss/procedures/`. Otherwise it writes under `~/.nanoboss/procedures/`.
Unscoped procedures persist as `procedures/<name>.ts`; scoped procedures persist
as `procedures/<package>/<leaf>.ts`.

Built-in procedures are exposed as slash commands and now also include the
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
then prints detailed failure output only when tests fail.

Run unit tests only:

```bash
bun run test:unit
```

This runs the compact test wrapper against `tests/unit`.

Run every test file with raw `bun test` discovery:

```bash
bun run test:raw
```

This includes unit and e2e tests.

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
