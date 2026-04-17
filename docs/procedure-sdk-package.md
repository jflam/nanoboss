# `@nanoboss/procedure-sdk`

`@nanoboss/procedure-sdk` is the stable author-facing package for nanoboss procedures. It gives procedure code a narrow, durable API surface for building deterministic workflows in code while leaving execution, persistence, transport, and policy to lower or higher layers.

This package owns:

- procedure authoring interfaces such as `Procedure`, `ProcedureApi`, `ProcedureResult`, and `RunResult`
- the stable helper contract for typed downstream agent calls via `TypeDescriptor<T>` and `jsonType(...)`
- procedure-side prompt-input helpers used to turn mixed text/image prompts into deterministic text and attachment views
- small stable helpers that procedure authors are expected to call directly, such as `expectData(...)`, `expectDataRef(...)`, `formatAgentBanner(...)`, `formatErrorMessage(...)`, and cancellation helpers
- re-exporting stable cross-package value types from `@nanoboss/contracts` so procedure code does not need to import multiple low-level packages

This package does not own:

- procedure execution or orchestration
- procedure discovery, registration, or source persistence
- durable run storage or ref materialization
- HTTP, MCP, ACP, or TUI transport details
- downstream agent process management
- session selection policy beyond the live controls exposed on `ctx.session`

## Public interface

The public entrypoint is [packages/procedure-sdk/src/index.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/procedure-sdk/src/index.ts).

The surface has four main parts.

### 1. Procedure authoring

- `Procedure`
- `ProcedureMetadata`
- `ProcedureApi`
- `ProcedureResult<T>`
- `RunResult<T>`
- `ProcedureRegistryLike`

`Procedure` is the core authoring contract:

```ts
interface Procedure {
  name: string;
  description: string;
  inputHint?: string;
  executionMode?: "agentSession" | "harness";
  execute(prompt: string, ctx: ProcedureApi): Promise<ProcedureResult | string | void>;
  resume?(prompt: string, state: KernelValue, ctx: ProcedureApi): Promise<ProcedureResult | string | void>;
}
```

Important rules:

- `execute(...)` and `resume(...)` receive plain text in `prompt`
- mixed text/image input is available through `ctx.promptInput`
- returning a string is shorthand for `{ display, summary }`
- returning `void` is shorthand for an empty result
- `RunResult<T>` is the public shape callers receive back from `ctx.agent.run(...)`, `ctx.procedures.run(...)`, and top-level runtime APIs

### 2. Procedure context

`ProcedureApi` is the deterministic workflow surface available inside procedure code:

- `ctx.agent`
  Bounded downstream agent invocation. Typed calls use `jsonType(...)` descriptors.
- `ctx.procedures`
  Nested procedure execution.
- `ctx.state`
  Read-only durable run/ref inspection.
- `ctx.session`
  Live session controls such as default downstream agent selection.
- `ctx.ui`
  Ephemeral UI/status emission.
- `ctx.assertNotCancelled()`
  Cooperative cancellation check for long deterministic loops.

Ownership boundaries matter here:

- `ctx.state` owns durable history and refs
- `ctx.session` owns live default-agent behavior
- `ctx.agent` and `ctx.procedures` start child runs
- procedure code should not reach into store, registry, or app-runtime internals directly

### 3. Typed data contract

Typed downstream calls are defined by:

- `TypeDescriptor<T>`
- `jsonType<T>(schema, validator)`
- `expectData(...)`
- `expectDataRef(...)`

The intended usage is:

```ts
import typia from "typia";
import { expectData, jsonType, type Procedure } from "@nanoboss/procedure-sdk";

interface Answer {
  answer: string;
}

const AnswerType = jsonType<Answer>(
  typia.json.schema<Answer>(),
  typia.createValidate<Answer>(),
);

export default {
  name: "example",
  description: "Typed example",
  async execute(_prompt, ctx) {
    const result = await ctx.agent.run("Return JSON.", AnswerType);
    const answer = expectData(result);
    return {
      data: answer,
      explicitDataSchema: AnswerType.schema,
    };
  },
} satisfies Procedure;
```

Important invariants:

- `TypeDescriptor.schema` is the explicit JSON schema for `data`
- `TypeDescriptor.validate` must be a pure runtime validator for the same shape
- `jsonType(...)` is intentionally fail-fast if called without concrete transformed arguments
- `expectData(...)` and `expectDataRef(...)` only treat `undefined` / missing refs as failure; valid falsy payloads such as `0`, `false`, `""`, or `null` are allowed
- when a typed child run is persisted, `explicitDataSchema` should travel with it so later clients can inspect both the explicit schema and inferred `dataShape`

### 4. Prompt input and helper utilities

Prompt helpers:

- `createTextPromptInput(...)`
- `normalizePromptInput(...)`
- `parsePromptInputPayload(...)`
- `promptInputDisplayText(...)`
- `promptInputToPlainText(...)`
- `promptInputAttachmentSummaries(...)`
- `hasPromptInputImages(...)`
- `hasPromptInputContent(...)`
- `buildImageTokenLabel(...)`

Behavioral expectations:

- `PromptInput` is the transport/runtime shape from `@nanoboss/contracts`
- `promptInputDisplayText(...)` is for transcript/run-history rendering
- `promptInputToPlainText(...)` is for procedure logic that still consumes plain text
- `promptInputAttachmentSummaries(...)` is the durable metadata view for attachments
- `parsePromptInputPayload(...)` is the API boundary validator; malformed prompt parts should be rejected rather than silently massaged into a different durable shape

Other stable helpers:

- `RunCancelledError`, `normalizeRunCancelledError(...)`, `defaultCancellationMessage(...)`
- `formatErrorMessage(...)`
- `formatAgentBanner(...)`
- `createTaggedJsonLineStream(...)`
- `summarizeText(...)`

## Runtime and on-disk model

`procedure-sdk` itself does not own on-disk state, but its types define how procedure code talks about runtime and persistence:

- `RunRef` identifies a run
- `Ref` identifies a stable stored value under a run
- `RunResult<T>` is the runtime-facing materialized view of a child or top-level run
- `ProcedureResult<T>` is the value a procedure returns before the runtime persists it

That means the normal flow is:

1. Author a `Procedure`.
2. Use `ctx.agent.run(...)` and `ctx.procedures.run(...)` to perform bounded child work.
3. Use `ctx.state` only to inspect durable prior results.
4. Return a `ProcedureResult<T>`.
5. Let the runtime/store own persistence and traversal.

The package intentionally does not expose filesystem paths, cell filenames, or transport envelopes as part of the authoring contract.

## Failure model and client expectations

Clients should expect fail-fast behavior.

- malformed `jsonType(...)` usage throws immediately
- malformed prompt-input payloads should be rejected at parse time
- `expectData(...)` and `expectDataRef(...)` throw when the caller claims a result must contain data or a data ref and that invariant is not met
- cancellation should normalize into `RunCancelledError` where possible so deterministic loops can branch on a small stable failure surface
- `formatErrorMessage(...)` is best-effort formatting for display and summaries, not a structured error protocol

Clients should not assume:

- that every `RunResult<T>` field is always populated
- that `display` and `data` mean the same thing
- that session policy or durable storage is implemented inside this package
- that image prompts are always supported by every downstream transport or typed call path

## Executable examples

The most useful contract examples are the package tests:

- [packages/procedure-sdk/tests/procedure-sdk-package.test.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/procedure-sdk/tests/procedure-sdk-package.test.ts)
  Minimal consumer-style import and `Procedure` authoring example.
- [packages/procedure-sdk/tests/prompt-input.test.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/procedure-sdk/tests/prompt-input.test.ts)
  Prompt parsing, transcript rendering, plain-text extraction, and attachment-summary examples.
- [packages/procedure-sdk/tests/result-contract.test.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/procedure-sdk/tests/result-contract.test.ts)
  Result assertion and failure-normalization examples.
- [packages/procedure-sdk/tests/json-type.test.ts](/Users/jflam/agentboss/workspaces/nanoboss/packages/procedure-sdk/tests/json-type.test.ts)
  Typed descriptor construction and runtime guard behavior.

If a future client capability depends on this package, the first readable example should usually be added as a `packages/procedure-sdk/tests/*.test.ts` contract test.
