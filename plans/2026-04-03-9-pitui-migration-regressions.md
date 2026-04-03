# Pi-TUI Migration Regression Review

## Context

Between commits `4fc6ffb` ("Migrate interactive frontend to pi-tui") and `38926f3` (HEAD), 32 commits were landed that replaced the legacy readline-based CLI with a pi-tui terminal UI, added async procedure dispatch, removed the `procedure_dispatch` synchronous tool, restructured MCP proxy/registration, and introduced session cleanup utilities. This report identifies self-contained issues introduced during this work, each scoped for a single fix agent.

---

## Issue 1: `nanoboss tui` routes to `runCliCommand` instead of `runTuiCommand`

**Root cause:** The `switch` statement in `runNanoboss()` groups `case "cli"` and `case "tui"` together and calls `runCliCommand(parsed.args)` for both [S1 lines 52-54]. A dedicated `runTuiCommand()` exists in `src/tui/run.ts` [S3 lines 28-41] with its own help text and `assertInteractiveTty("tui")` branding, but it is never dispatched. The `tui` subcommand was added in commit `4fc6ffb` but the dispatcher kept wiring both aliases to the `cli` handler [C1].

**Impact:** Running `nanoboss tui --help` prints CLI help text ("Usage: nanoboss cli ...") instead of TUI help text. Error messages say "nanoboss cli requires an interactive TTY" instead of "nanoboss tui requires an interactive TTY".

**Fix scope:** Change `nanoboss.ts` line 53 to route `case "tui"` to `await runTuiCommand(parsed.args)` instead of `runCliCommand`. Add a test case in `tests/unit/nanoboss.test.ts` verifying that `tui` is a distinct routing branch.

**Files:** `nanoboss.ts:52-54`, `src/tui/run.ts:28-41`, `tests/unit/nanoboss.test.ts`

---

## Issue 2: `session_ready` action drops the session's canonical `cwd`

**Root cause:** The `session_ready` reducer action [S5 lines 50-63] calls `createInitialUiState({ cwd: state.cwd, ... })` which preserves the *previous* state's cwd (typically `process.cwd()`) rather than the server-provided session cwd. The `SessionResponse` interface in the controller already carries `cwd` [S4 line 28], and `applySession()` has access to `session.cwd` [S4 line 195], but the dispatch at line 201 does not pass cwd into the `session_ready` action. When resuming a session whose `cwd` differs from the TUI process's working directory, the header at `views.ts:79` renders the wrong path.

**Impact:** After `nanoboss resume`, the TUI header may show the current directory instead of the session's original directory.

**Fix scope:** Add `cwd` to the `session_ready` UiAction variant in `src/tui/reducer.ts:19-25`, thread `session.cwd` through `applySession()` in `src/tui/controller.ts:201`, and use `action.cwd` instead of `state.cwd` in the reducer. Add a unit test in `tests/unit/tui-reducer.test.ts` confirming the session cwd overwrites the initial cwd.

**Files:** `src/tui/reducer.ts:17-25,50-63`, `src/tui/controller.ts:195-208`, `src/tui/state.ts:46-66`, `src/tui/views.ts:78-80`

---

## Issue 3: Optimistic `/model` persistence has no rollback on send failure

**Root cause:** When the user types `/model <provider> <model>`, the controller calls `applyLocalSelection()` at line 159 which immediately dispatches `local_agent_selection` [S9 controller.ts:254-261] updating the UI state's `agentLabel` and `defaultAgentSelection`. It then calls `maybePersistDefaultSelection()` [S10 controller.ts:263-283] which durably writes the new default to disk via `writePersistedDefaultAgentSelection()` [S16 settings.ts:32-41]. Only then does `forwardPrompt()` actually send the command to the server [controller.ts:285-302]. If `sendSessionPrompt` throws, the `local_send_failed` handler [S11 reducer.ts:86-107] clears transient run state but does not revert `agentLabel` or `defaultAgentSelection` and the on-disk settings file has already been written. This was introduced in commit `ea12e0e` ("Add TUI status bar and persisted model defaults") [C2].

**Impact:** If the HTTP send fails, the status bar and persisted settings show a model that the server never accepted.

**Fix scope:** In `src/tui/controller.ts`, defer `applyLocalSelection()` and `maybePersistDefaultSelection()` until after `forwardPrompt()` succeeds, or snapshot the previous selection and roll back both state and settings on error. Add a test in `tests/unit/tui-controller.test.ts` that verifies rollback when `sendSessionPrompt` rejects.

**Files:** `src/tui/controller.ts:157-166,254-302`, `src/tui/reducer.ts:86-118,113-118`, `src/settings.ts:32-41`

---

## Issue 4: Permanent SSE stream loss traps the TUI in busy mode

**Root cause:** When `run_started` fires, the reducer sets `inputDisabled: true` [S13 reducer.ts:131-159]. Input is only re-enabled by `run_completed`, `run_failed`, or `local_send_failed` [S14 reducer.ts:294-332, S11 reducer.ts:86-107]. The SSE stream's `onError` callback in the controller [S12 controller.ts:216-219] only logs a `local_status` text line and never transitions the run to a terminal state. If the SSE connection drops permanently, no `run_completed`/`run_failed` event is ever delivered, so `inputDisabled` stays `true` indefinitely. The legacy CLI fallback that could have provided reconnect behavior was removed in commit `53ab99e` [C3].

**Impact:** If the HTTP server restarts or the network drops during an active run, the TUI becomes permanently stuck in busy mode and the user cannot type any input (including `/quit`).

**Fix scope:** Add a `stream_lost` action to the reducer that transitions the current run to failed state and re-enables input. Fire it from the controller's `onError` callback after bounded reconnect attempts fail. Add test coverage in `tests/unit/tui-controller.test.ts` and `tests/unit/tui-reducer.test.ts`.

**Files:** `src/tui/controller.ts:210-221`, `src/tui/reducer.ts:17-46,86-122`, `src/http-client.ts`

---

## Issue 5: `getNanobossHome()` duplicated across `src/config.ts` and `src/settings.ts`

**Root cause:** `src/config.ts:17` exports `getNanobossHome()` which resolves `$NANOBOSS_HOME` or falls back to `~/.nanoboss`. `src/settings.ts:44` has a private copy of the same function. The settings module was added in commit `ea12e0e` (TUI status bar) and duplicated the home resolution instead of importing from config. Both resolve the same environment variable and default path but live in separate files.

**Impact:** If the home resolution logic is changed in one place but not the other, settings could be written to a different directory than config expects. This is a maintenance hazard.

**Fix scope:** Remove the private `getNanobossHome()` from `src/settings.ts` and import it from `src/config.ts`. Update the corresponding test if any.

**Files:** `src/settings.ts:44-48`, `src/config.ts:17-21`

---

## Issue 6: Deleted `src/mcp-proxy.ts` and `src/mcp-registration.ts` test files reference removed modules

**Root cause:** Git status shows `tests/unit/mcp-proxy.test.ts` and `tests/unit/mcp-registration.test.ts` as untracked (newly added) files [git status]. However, the `src/mcp-proxy.ts` file is also shown as untracked (new file, not yet committed). The `dc5acb1` commit message says "Remove global MCP proxy path" while the unstaged diff re-adds MCP proxy/registration. The test files at `tests/unit/mcp-proxy.test.ts` (204 lines removed in stat) and `tests/unit/mcp-registration.test.ts` (173 lines removed in stat) appear to have been deleted from the committed state but new untracked versions exist. The working tree is inconsistent with HEAD.

**Impact:** Running `bun test` may not find the mcp-proxy and mcp-registration tests since the committed versions were deleted and the new untracked versions haven't been committed.

**Fix scope:** Stage and commit the new `src/mcp-proxy.ts`, `src/mcp-registration.ts`, `tests/unit/mcp-proxy.test.ts`, and `tests/unit/mcp-registration.test.ts` files. Verify all imports resolve and tests pass.

**Files:** `src/mcp-proxy.ts`, `src/mcp-registration.ts`, `tests/unit/mcp-proxy.test.ts`, `tests/unit/mcp-registration.test.ts`

---

## Issue 7: `doctor.ts` imports `registerSupportedAgentMcp` from `./mcp-registration.ts` but that file was previously deleted

**Root cause:** The committed `src/doctor.ts` (after applying the unstaged diff) imports `registerSupportedAgentMcp` from `./mcp-registration.ts` [doctor.ts line 1]. The `--register` flag was re-added in the unstaged changes. However, `src/mcp-registration.ts` is shown as an untracked file in git status, meaning it is not committed yet. If only the doctor.ts changes are committed without also committing `src/mcp-registration.ts`, the build will break.

**Impact:** The uncommitted state has a cross-file dependency that will cause import failures if files are committed selectively.

**Fix scope:** Ensure `src/mcp-registration.ts` and `src/doctor.ts` are committed together. The `--register` test in `tests/unit/doctor.test.ts` should also be committed in the same batch.

**Files:** `src/doctor.ts:1`, `src/mcp-registration.ts`, `tests/unit/doctor.test.ts`

---

## Issue 8: `createHttpSession` in controller does not pass `defaultAgentSelection` for fresh sessions

**Root cause:** When creating a new session (not resume), `controller.ts:114` calls `createHttpSession(serverUrl, cwd)` with only two arguments. The `createNewSession` method at line 227 does pass `state.defaultAgentSelection` as the third argument. So fresh TUI launches always create sessions with the server's default agent, ignoring any persisted default from `src/settings.ts`. The resume path at line 109-112 also does not pass the persisted selection.

**Impact:** If the user previously saved a default model via `/model`, launching a fresh TUI session does not honor that saved preference. Only `/new` within an existing session does.

**Fix scope:** In `controller.ts` `run()` method, load persisted default agent selection from settings and pass it to `createHttpSession`. Alternatively, read it in `NanobossTuiApp` and pass it to the controller params.

**Files:** `src/tui/controller.ts:108-117`, `src/tui/app.ts`, `src/settings.ts`

## Sources
- **[S1]** `nanoboss.ts` lines 48-80 (current working tree)
- **[S3]** `src/tui/run.ts` lines 28-54 (current working tree)
- **[S4]** `src/tui/controller.ts` lines 26-33, 195-221 (current working tree)
- **[S5]** `src/tui/reducer.ts` lines 17-63 (current working tree)
- **[S9]** `src/tui/controller.ts` lines 157-165 (current working tree)
- **[S10]** `src/tui/controller.ts` lines 263-283 (current working tree)
- **[S11]** `src/tui/reducer.ts` lines 86-118 (current working tree)
- **[S12]** `src/tui/controller.ts` lines 210-221 (current working tree)
- **[S13]** `src/tui/reducer.ts` lines 131-159 (current working tree)
- **[S14]** `src/tui/reducer.ts` lines 294-332 (current working tree)
- **[S16]** `src/settings.ts` lines 32-41 (current working tree)
- **[C1]** Commit `4fc6ffb`, "Migrate interactive frontend to pi-tui"
- **[C2]** Commit `ea12e0e`, "Add TUI status bar and persisted model defaults"
- **[C3]** Commit `53ab99e`, "Remove legacy non-TTY CLI fallback"
