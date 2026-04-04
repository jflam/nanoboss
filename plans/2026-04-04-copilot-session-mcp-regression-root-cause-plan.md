# 2026-04-04 Copilot session-MCP regression root-cause and rollback plan

## Decision update

The direction is no longer:

- restore global MCP only as a temporary Copilot compatibility path while preserving attached `nanoboss-session`

The direction is now:

- remove the session-based MCP pathway entirely
- return to a single globally registered `nanoboss` MCP server for **all four agents**:
  - Claude
  - Gemini
  - Codex
  - Copilot
- make session targeting explicit in prompt/tool protocol rather than implicit in ACP-attached MCP transport

This plan reframes the problem accordingly.

---

## Context

We removed the global `nanoboss` MCP path and moved toward ACP session-scoped injection of `nanoboss-session` for slash-command dispatch and session inspection.

Live `/research` runs on Copilot now fail with messages like:

- `Required nanoboss-session procedure_dispatch_start / procedure_dispatch_wait tools are not available in this conversation.`
- `Unable to access the required nanoboss-session dispatch tools in this environment.`

The earlier framing was:

> Did we remove the global MCP path without re-validating that Copilot actually surfaces ACP-injected session MCP tools?

That framing is still true as root-cause analysis, but the product decision has changed.

The question is now:

> What is the smallest safe rollback and simplification that gets nanoboss back to one reliable MCP topology across all four agents?

The answer supported by the repo history is:

> restore and standardize on the global registered `nanoboss` MCP pathway, and remove attached session MCP entirely.

---

## Historical findings that still matter

## 1. The attached-session direction was intentional, but not sufficiently validated for Copilot

`plans/2026-04-03-6-one-true-session-mcp-plan.md` described the desired end state as:

- one MCP implementation path
- attached `nanoboss-session` only
- no top-level global `nanoboss` MCP proxy
- no prompt/runtime logic choosing between `nanoboss` and `nanoboss-session`
- no session-id archaeology or ambient current-session fallback

So the attached-session architecture was not accidental.

However, intention is not validation.

## 2. The last recorded real cross-provider validation said Copilot still needed the global MCP path

`plans/2026-04-03-7-procedure-dispatch-prompt-clarity-plan.md` records actual live results.

### First validation pass
- Claude: attached `nanoboss-session` worked
- Gemini: attached `nanoboss-session` worked
- Codex: attached `nanoboss-session` worked
- Copilot: **failed**

### Fix applied after the first pass
- restored `nanoboss doctor --register`
- restored the global `nanoboss mcp proxy`
- updated registration so all agents received a valid global `nanoboss` MCP config
- updated prompting so the agent could use either:
  - attached `nanoboss-session`
  - or global `nanoboss`

### Final validation pass
- Claude/Gemini/Codex: passed via attached `nanoboss-session`
- Copilot: passed via **globally registered** `nanoboss-procedure_dispatch_start` / `nanoboss-procedure_dispatch_wait`

### Recorded conclusion
The plan explicitly concluded:

- attached session MCP worked for Claude, Gemini, and Codex
- **Copilot needed a valid global `nanoboss` MCP registration path**

This remains the most important historical fact.

## 3. Fresh probing still matches the old Copilot limitation

Fresh evidence collected today continues to support the earlier conclusion.

### Real Copilot ACP slash-dispatch logs
Files such as:
- `~/.nanoboss/agent-logs/8078387b-8f6c-454f-ae1a-49f9043b5a76.jsonl`
- `~/.nanoboss/agent-logs/6a48dae0-a423-46c8-b818-5a076eb3012d.jsonl`

show:
- ACP session config updates
- then plain text failure from Copilot
- **no** `procedure_dispatch_start`
- **no** `procedure_dispatch_wait`

### Direct ACP injection probe
A direct `invokeAgent(...)` probe was run with `sessionMcp` attached.
Copilot still answered `FAILED` instead of calling the tool.

### Fake stdio MCP probe
A fake ACP-injected stdio MCP server was attached to a fresh Copilot ACP session.
The fake server process was never launched.
That strongly suggests Copilot in this environment is not honoring the injected stdio `mcpServers` path the way nanoboss expects.

So the attached-session path remains unproven for Copilot and is contradicted by fresh evidence.

---

## Commit-history research

This section focuses on the commits from the first global-MCP removal attempt through the current attached-only state.

Reviewed range:

- `dc5acb1` → `HEAD`

### Chronological interpretation

1. `dc5acb1` — **Remove global MCP proxy path**
   - original removal of the global path
   - not the right rollback target, because later work restored the desired global behavior

2. `f4d688e` — **Restore nanoboss MCP registration and global proxy**
   - reintroduced the explicit global `nanoboss` MCP path
   - reintroduced registration support
   - this is the key repair commit we want to preserve conceptually

3. `f376789` — **Remove legacy procedure_dispatch compatibility path**
   - simplified older dispatch compatibility behavior
   - did **not** remove the restored global MCP model
   - part of the last validated architecture story

4. `3bd572c` — **Document async dispatch validation across all supported agents**
   - docs-only, but authoritative evidence
   - records that Copilot still needed the global path

5. `74a97db` through `9526e50`
   - mostly unrelated or mixed work: TUI cards, aliases, server/structure cleanup, session repository refactors
   - some files overlap with MCP/session code, but these commits are not primarily the bad architectural pivot

6. `f12f5c5` — **Collapse MCP proxy onto shared session server path**
   - global MCP stopped being its own clear path
   - the global proxy became a wrapper over the session-server implementation
   - introduced exactly the kind of accidental complexity that should now be removed

7. `1ee8264` — **Remove global nanoboss MCP path**
   - final attached-only step
   - deleted the explicit global MCP command and registration support

---

## What should be excised

## Definitely excise

### `1ee8264` — Remove global nanoboss MCP path
This commit:
- deleted `src/mcp/proxy.ts`
- deleted `src/mcp/registration.ts`
- removed `nanoboss mcp`
- removed `nanoboss doctor --register`
- rewrote dispatch prompting to assume attached `nanoboss-session` only
- removed current-session-backed global behavior from the MCP layer

This is the direct attached-only regression step and should be reversed.

### `f12f5c5` — Collapse MCP proxy onto shared session server path
This commit:
- collapsed the explicit global proxy implementation into the session-server machinery
- introduced extra server-name/instruction parameterization to make one path impersonate both global and session MCP
- increased coupling between the global and session MCP concepts

This is the accidental-complexity commit and should also be reversed.

## Keep

### `f4d688e` — Restore nanoboss MCP registration and global proxy
Keep conceptually and likely keep materially.
This is the last clear restoration of the global working path.

### `f376789` — Remove legacy procedure_dispatch compatibility path
Keep unless separate evidence later shows it is incompatible with the desired global-only topology.
It is not the cause of the current regression.

### `3bd572c` — Document async dispatch validation across all supported agents
Keep as evidence.
It is the key validation artifact explaining why global MCP is the correct default.

## Probably do not wholesale revert

### `d854a94`, `b195f2f`, `9526e50`
These commits are mixed refactors involving aliases, structure, and session metadata.
They are not primarily “the bad MCP fix attempt.”
Reverting them wholesale would create a lot of collateral churn without directly solving the MCP topology issue.

---

## Recommended rollback target

## Immediate code baseline

The best surgical rollback is:

- revert `1ee8264`
- revert `f12f5c5`

That effectively returns the MCP topology to the state represented by **`9526e50`** plus the restored global-path behavior from earlier commits.

This is the cleanest rollback that:
- removes the attached-only architectural pivot
- removes the extra proxy/session-server collapse complexity
- preserves later unrelated work

## Conceptual validation baseline

The best historical baseline for the new plan is:

- **`f376789`** code
- plus the validation artifact in **`3bd572c`**

That is the last recorded point where:
- the global MCP path had already been restored
- real cross-provider validation had been written down
- Copilot’s need for the global path had been proven rather than assumed

---

## Updated architecture decision

We should standardize on **one globally registered MCP server**:

- server name: `nanoboss`
- used by Claude, Gemini, Codex, and Copilot
- authoritative for:
  - slash-command dispatch
  - session/history inspection
  - durable cell/ref queries

We should remove:

- ACP-attached `nanoboss-session`
- session-scoped MCP injection as a required runtime path
- prompt language that assumes the attached session MCP exists
- dual-path logic that chooses between attached and global MCP

This is a change in architecture, not merely a compatibility patch.

It prioritizes:

- one surfaced MCP topology across all providers
- simpler operations and debugging
- explicit session targeting over transport-bound implicit session affinity

---

## Session targeting model under global-only MCP

If attached session MCP is removed, session affinity must stop being implicit.

That means the global-only design should explicitly carry session context.

### Prompt-level guidance
Nanoboss can inject the current session id into the dispatch prompt.
That gives the model the needed context without requiring attached MCP.

### Tool contract expectations
The global MCP tools should support one of the following clearly:

1. explicit `sessionId` arguments for session-targeted operations
2. or a documented current-session fallback for convenience

The important design constraint is:

> session identity must be explicit in the protocol or clearly defined in one global implementation, not hidden in an ACP attachment assumption.

Prompt injection of the session id is useful, but it is **not** enough by itself unless the globally exposed tools can use that id consistently.

---

## Phased implementation plan

## Phase 1 — Back out the failed attached-only pivot

1. Revert `1ee8264`
2. Revert `f12f5c5`
3. Confirm the repo once again contains:
   - `src/mcp/proxy.ts`
   - `src/mcp/registration.ts`
   - `nanoboss mcp`
   - `nanoboss doctor --register`
   - dispatch prompt text that does not require attached-only MCP

Goal:
- restore the explicit global MCP surface
- remove the extra proxy/session-server impersonation layer

## Phase 2 — Re-baseline around global-only MCP

1. Treat `nanoboss` as the only supported MCP server name
2. Make `doctor --register` the standard setup path again
3. Ensure registration for:
   - Claude
   - Gemini
   - Codex
   - Copilot
4. Remove any architectural language that presents attached `nanoboss-session` as the primary or preferred path

Goal:
- one MCP server topology across all agents

## Phase 3 — Make session targeting explicit

1. Update dispatch prompts to include current session id where required
2. Ensure global dispatch and inspection tools can target the intended session explicitly
3. Avoid hidden reliance on:
   - ACP attachment context
   - ambient attached tool availability
   - repo-file archaeology by the model

Goal:
- preserve correct session semantics without session-attached transport

## Phase 4 — Delete session-MCP-only plumbing

Remove or retire:
- attached `nanoboss-session` assumptions in prompts
- ACP session-scoped MCP injection as a required mechanism
- command/help/docs that advertise session MCP as the canonical runtime path
- runtime branching that prefers attached session MCP over global MCP

Potential code areas to inspect after the two reverts:
- `src/mcp/attachment.ts`
- `src/mcp/session-stdio.ts`
- `src/mcp/session.ts`
- `src/core/service.ts`
- ACP session bootstrap/update wiring

Goal:
- remove the remaining dead conceptual weight of the attached-session design

## Phase 5 — Revalidate all four agents against one path

Run real live validation for:
- Claude
- Gemini
- Codex
- Copilot

Validation criteria:
- the global `nanoboss` MCP server is surfaced by the agent
- `procedure_dispatch_start` can be called
- `procedure_dispatch_wait` can be called
- slash-command execution succeeds
- session/history inspection succeeds
- no provider requires an attached session MCP path

Goal:
- replace assumption with evidence before further deletions

---

## Safe-scope statement

This plan does **not** recommend rewinding all the way back to `dc5acb1` or earlier.

Reason:
- `dc5acb1` is the original bad removal of the global path
- `f4d688e` is the repair commit that restored the desired global behavior
- broad rollback before `f4d688e` would discard useful later work and move in the wrong direction

The intended surgery is therefore narrow:

- excise the late attached-only pivot (`f12f5c5`, `1ee8264`)
- preserve the restored global architecture lineage (`f4d688e`, `f376789`, `3bd572c`)
- simplify forward from there

---

## Recommended next action in the repo

1. Revert `1ee8264`
2. Revert `f12f5c5`
3. Re-read the resulting MCP code shape around:
   - `src/mcp/proxy.ts`
   - `src/mcp/registration.ts`
   - `src/core/service.ts`
   - `nanoboss.ts`
4. From that restored baseline, make a deliberate follow-up simplification patch that:
   - removes session-attached MCP as a product concept
   - standardizes prompt/tooling around global MCP only
   - keeps session identity explicit
5. Validate all four agents live before deleting any remaining compatibility logic

---

## Bottom line

The repo history supports a very specific conclusion:

- the last documented real cross-provider validation said Copilot still needed the global MCP path
- fresh probing today still matches that limitation
- the commits most directly responsible for the current attached-only complexity are:
  - `f12f5c5`
  - `1ee8264`
- the cleanest path forward is **not** to salvage attached session MCP
- the cleanest path forward is to:
  - revert those two commits
  - restore the explicit global `nanoboss` MCP path
  - remove session-based MCP entirely
  - standardize all four agents on one global registered MCP server

That is now the recommended architectural and implementation direction.
