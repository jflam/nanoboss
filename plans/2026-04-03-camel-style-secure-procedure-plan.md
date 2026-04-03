# 2026-04-03 Deferred plan: CaMeL-style secure nanoboss procedure

## Status

Deferred, not yet implemented.

This is a promising direction for a future nanoboss procedure, but it depends on a few runtime and API constraints if we want anything close to the security properties described in CaMeL / privileged-vs-quarantined agent designs.

---

## Summary

Explore a new nanoboss procedure that applies a **privileged planner + quarantined parser + trusted interpreter** architecture to coding and other tool-using workflows.

Working name ideas:

- `/secure-code`
- `/guarded-agent`
- `/capability-code`
- `/camel-procedure`

The core idea is:

1. a **privileged** agent sees only trusted user intent and policy
2. a **quarantined** agent is allowed to inspect untrusted external content
3. the privileged side emits a **typed plan / DSL / AST**, not arbitrary tool calls
4. the procedure itself executes that plan in trusted TypeScript
5. values are tracked with **taint** and **capability** metadata
6. sensitive actions are blocked unless policy allows them or the user explicitly approves

This is inspired by CaMeL-style prompt-injection defenses and is especially relevant for coding flows that read untrusted documentation, example code, issue content, or pasted logs before proposing edits.

---

## Why this is interesting

Nanoboss procedures already provide a natural place to implement a trusted orchestration layer:

- procedures are first-class in `src/types.ts`
- they execute host-side TypeScript via `execute(prompt, ctx)`
- they can orchestrate downstream calls through `ctx.callAgent(...)`
- they can compose other procedures with `ctx.callProcedure(...)`
- they can persist small machine-oriented results and richer user-facing displays

That makes procedures a strong fit for a **restricted interpreter** model.

This is more promising than letting an unconstrained downstream coding agent directly read arbitrary external text and immediately invoke powerful tools.

---

## Current fit with nanoboss

## What procedures can already do well

A procedure can already implement:

- a privileged planning step using typed JSON output
- a quarantined extraction/parsing step using a second model call
- a trusted execution loop in TypeScript
- host-side policy checks before file writes, shell commands, commits, or follow-up agent calls
- a compact machine result in `data` and a fuller explanation in `display`

Examples in the current codebase already show the right building blocks:

- `commands/research.ts` uses typed downstream output and host-side file writing
- `commands/linter.ts` uses a loop of discover → act → re-check
- `commands/second-opinion.ts` uses multi-agent orchestration with typed critique output

So a **CaMeL-inspired specialized workflow** is achievable as a procedure.

## What procedures cannot guarantee today

The current nanoboss runtime does **not** yet provide the same security boundary that CaMeL aims for.

### 1. Named refs are not opaque handles today

In `src/call-agent.ts`, named refs passed through `ctx.callAgent(..., { refs })` are resolved and serialized directly into the downstream prompt.

That means refs behave like:

```text
<ref name="x">
...actual content...
</ref>
```

not like opaque symbolic handles.

Implication:

- if a privileged agent receives a ref containing untrusted text, it is exposed to that text directly
- this breaks the clean privileged/quarantined separation we would ideally want

### 2. Per-call agent selection is shallow

`DownstreamAgentSelection` currently exposes only:

- `provider`
- `model`

There is no per-call way to declare:

- no tools
- limited tool allowlist
- different ACP args
- different sandbox policy
- a true quarantine profile

Implication:

- a procedure can choose a different provider/model
- it cannot strongly enforce a no-tools quarantined runtime boundary for one call

### 3. Default downstream config is broad

`src/config.ts` defaults copilot ACP to `--allow-all-tools`.

Implication:

- the out-of-the-box downstream environment is broad and agent-friendly
- this is the opposite of a strict quarantine boundary

### 4. Procedures do not mediate every downstream tool call

A procedure can decide **when** to call an agent, but once it hands off to `ctx.callAgent(...)`, the downstream agent runtime owns its own tool behavior.

Implication:

- procedures are good for orchestrating a secure workflow
- procedures alone are not enough to make arbitrary downstream tool use provably safe

---

## Goal

Build a **specialized secure procedure** for coding/research tasks involving untrusted external inputs, where:

- untrusted content can be parsed and summarized
- raw untrusted tokens do not directly influence sensitive actions
- code changes are represented structurally, not as unconstrained free-form agent behavior
- the procedure itself enforces policy over data flow and sink permissions

This would not aim to secure every nanoboss workflow. It would aim to offer one clearly-scoped, more-defensible path for high-risk tasks.

---

## Non-goals

- replacing ordinary `/default` conversational flows
- claiming complete prompt-injection immunity for all nanoboss procedures
- securing arbitrary external-agent tool use without runtime changes
- building a universal formal verifier for every plan or patch
- removing ordinary flexible coding procedures in favor of only locked-down ones

---

## Proposed end state

A future procedure, likely `/secure-code`, should work roughly like this:

1. user provides a task plus optional trusted local context
2. procedure gathers any needed untrusted inputs through a quarantined path
3. quarantined parsing yields strict typed artifacts only
4. privileged planner emits a typed plan or small DSL
5. a trusted TypeScript interpreter executes that plan
6. all intermediate values carry taint/capability metadata
7. sensitive sinks reject tainted values unless policy explicitly allows them
8. any declassification or risky sink usage is surfaced to the user as a deliberate approval point

---

## High-level design

## 1. Privileged planner

Use `ctx.callAgent(..., ResultType)` with a typed plan schema.

The privileged planner should see only:

- the user request
- trusted repo-local policy
- trusted tool definitions
- trusted summaries of prior safe steps
- opaque identifiers or sanitized structured results from quarantined work

The privileged planner should **not** receive raw untrusted external content.

Possible output shape:

```ts
interface SecurePlan {
  goal: string;
  steps: SecureStep[];
}

type SecureStep =
  | { kind: "read_local_file"; path: string }
  | { kind: "fetch_untrusted_doc"; sourceId: string }
  | { kind: "extract_api_surface"; sourceVar: string; outputVar: string }
  | { kind: "propose_patch"; specVar: string; outputVar: string }
  | { kind: "write_patch"; patchVar: string }
  | { kind: "run_check"; command: string }
  | { kind: "request_approval"; reason: string; varName?: string };
```

The plan can be JSON or a small DSL, but it should be narrow enough that the host interpreter can reason about it.

## 2. Quarantined parsing / extraction

Use separate downstream calls for untrusted content.

These calls should be limited to tasks like:

- extract function signatures
- extract structured config fields
- classify whether a file is relevant
- summarize documentation into a strict schema
- convert prose docs into a machine-shaped API description

The quarantined output should be highly structured.

Examples:

- allowed symbols
- endpoint names
- parameter lists
- diff candidates
- issue classification labels

The raw content should not be forwarded back into the privileged planner unless explicitly declassified.

## 3. Trusted interpreter inside the procedure

The procedure itself should execute the plan in TypeScript.

This is the core trust boundary.

The interpreter should:

- hold runtime variables in memory
- attach taint/capability metadata to each variable
- enforce allowed step transitions
- reject invalid or untrusted sink usage
- produce audit-friendly logs in the final `display`

Suggested runtime shape:

```ts
interface GuardedValue<T = unknown> {
  data: T;
  taint: "trusted" | "untrusted" | "mixed";
  provenance: string[];
  capabilities: string[];
}
```

## 4. Taint and capability model

A simple first version could track:

- `trusted`: derived only from user prompt, local policy, or trusted local files
- `untrusted`: derived from web content, third-party docs, pasted content, issue text, or model parsing of those
- `mixed`: combined from trusted and untrusted sources

Capabilities can model what a value is allowed to influence, for example:

- `display_ok`
- `patch_ok`
- `write_repo_ok`
- `shell_arg_ok`
- `network_dest_ok`
- `commit_message_ok`

Conservative default:

- tainted values may be displayed or stored for inspection
- tainted values may not directly control sensitive sinks

## 5. Guarded sinks

The interpreter should own the sensitive actions.

Examples:

- writing repo files
- generating or applying patches
- running shell commands
- invoking git commit flows
- sending text back into a privileged agent call
- contacting network endpoints

Examples of policy:

- patch content may be tainted, but patch target paths must be trusted
- shell command templates may be trusted, but tainted values may not fill arbitrary command positions
- commit messages should be trusted or explicitly approved
- raw untrusted documentation should not be fed back to the privileged planner

## 6. Human approval / declassification

When a workflow genuinely needs a tainted value to influence a sensitive sink, require a declassification step.

Examples:

- “Use extracted email address from untrusted content as recipient?”
- “Apply patch whose structure was derived from third-party docs?”
- “Run this command with arguments derived from external text?”

This could start as a stop-and-report flow rather than a full interactive approval UI.

## 7. Machine-oriented outputs

The procedure should return small structured data and keep the richer audit story in `display`.

Example result shape:

```ts
interface SecureCodeResult {
  verdict: "completed" | "blocked" | "needs_approval";
  planSummary: string;
  taintFindings: string[];
  appliedPatchRef?: ValueRef;
  blockedSink?: string;
}
```

This matches the existing nanoboss convention of small machine `data` plus richer human `display`.

---

## What can be built as a procedure today

Even without runtime changes, a worthwhile **prototype** is possible.

A first procedure could:

- keep the privileged planner blind to raw untrusted content by construction
- avoid passing tainted refs back into privileged calls
- ask quarantined calls only for strict typed output
- generate patches or edit specs as structured JSON
- apply edits in host-side TypeScript only after validation
- avoid delegating direct repo editing to a broad downstream coding agent
- fail closed when policy is ambiguous

This would not be formally secure, but it could still be much safer than unconstrained agent-edit loops.

---

## Runtime improvements needed for a stronger version

To get closer to a real CaMeL-style implementation, nanoboss likely needs runtime support beyond a single procedure.

## 1. Opaque refs

Add a mode where refs can be passed between steps as symbolic handles rather than prompt-inlined content.

Desired behavior:

- privileged calls receive a handle like `$VAR_7`
- only trusted host code can dereference the handle
- quarantined outputs can be referred to without exposing raw content upstream

This is the biggest missing primitive.

## 2. Per-call agent sandbox / tool profile

Extend `ctx.callAgent(...)` or `DownstreamAgentSelection` to support a stronger per-call execution profile.

Possible future options:

```ts
{
  agent: { provider: "copilot", model: "..." },
  sandbox: {
    tools: "none" | "limited" | "full",
    allowlist?: string[],
  }
}
```

Without this, “quarantined” is mostly a convention, not a runtime guarantee.

## 3. Host-mediated downstream tools

A future runtime could expose a restricted, procedure-owned tool surface to a downstream agent call instead of handing it a broad default ACP environment.

That would let the procedure approve or deny each sensitive operation based on taint/capability checks.

## 4. Better approval primitives

For declassification, a future version may want:

- a resumable approval model
- explicit blocked/awaiting-approval procedure states
- durable approval audit logs

---

## Suggested phased plan

## Phase 0: design and threat model

Before implementation:

- define exact trust boundaries
- enumerate untrusted input classes
- define allowed sinks
- choose a minimal taint lattice
- choose one concrete procedure scope

Best candidate first scope:

- “read third-party docs and propose local repo edits”

That is narrow, useful, and directly exposed to prompt-injection risk.

## Phase 1: prototype as a procedure only

Implement a first `/secure-code` procedure with no runtime changes.

Rules:

- privileged planner gets only trusted inputs
- quarantined parser returns strict typed output only
- interpreter applies a small JSON plan
- no unconstrained agent-driven file editing
- no passing tainted refs into privileged calls
- blocked actions report clearly in `display`

Success criteria:

- can complete simple doc-to-patch workflows
- demonstrates clear audit trail of taint decisions
- makes the architectural value obvious

## Phase 2: add runtime support for opaque refs and per-call sandboxing

If the prototype proves useful, extend the runtime.

Priority order:

1. opaque refs
2. per-call tool/sandbox profile
3. procedure-owned tool mediation

These would materially improve the security story.

## Phase 3: broaden to more workflows

After the coding-focused version, expand to other domains:

- secure research assistant
- secure issue triage
- secure customer-support summarization
- secure email/calendar style assistants

Only after the primitives are mature.

---

## Open questions

- should the trusted interpreter use JSON plans or a tiny textual DSL?
- should patch application use `edit`-style structured operations or unified diffs?
- how much repo-local trusted context is safe to expose to the privileged planner?
- should local repo files always be treated as trusted, or only user-selected ones?
- how should declassification be represented in a CLI-first workflow?
- do we want a reusable taint/capability library in `src/` or keep this procedure-local at first?

---

## Why this remains deferred for now

This is strategically interesting, but not the highest-leverage immediate task.

Reasons to defer:

- the current ref model is not yet compatible with the strongest version of the design
- there is no per-call quarantined tool profile yet
- the first implementation should start with a careful threat model, not a rushed prototype
- existing procedure/runtime work is currently focused elsewhere

That said, this is a strong candidate for future exploration because it aligns well with nanoboss’s procedural architecture and could differentiate nanoboss as a safer orchestration layer for agentic coding.

---

## Recommendation

Revisit this once one of the following becomes true:

- there is active demand for a safer coding/research procedure
- nanoboss adds opaque refs
- nanoboss adds per-call sandbox/tool profiles
- prompt-injection-resistant workflows become a product priority

When revisited, start with a **narrow coding workflow prototype** rather than a general-purpose secure agent framework.
