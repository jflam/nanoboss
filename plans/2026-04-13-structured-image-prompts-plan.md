# Structured Image Prompts Plan

## Goal

Add image prompt support to `nanoboss` without introducing platform-specific dependencies into core runtime code.

The first shipped path should be:

- cross-platform architecture
- `default`-only downstream delivery
- structured prompt model in core
- inline image tokens in the TUI editor so users can add, move, and delete images directly in the prompt buffer

## Why This Shape

Current `nanoboss` prompt flow is text-only at every boundary:

- TUI and HTTP submit `prompt: string`
- service and procedure runtime treat prompt input as plain text
- ACP server flattens inbound blocks to text
- downstream ACP client always sends a single text block

ACP itself supports ordered prompt blocks via `prompt: Array<ContentBlock>`, including interleaved text and image blocks. The missing piece is a structured prompt representation inside `nanoboss`.

## Product Decisions

### In Scope

- Structured prompt model in `nanoboss`
- TUI image insertion via `Ctrl+V`
- Inline editor tokens like `[Image 1: PNG 1440x900 620KB]`
- Ordered text/image prompt parts forwarded to downstream ACP for the `default` procedure path
- Procedure runtime access to structured prompt data via `ctx`

### Out of Scope For First Cut

- Full image support for all procedures
- Image previews in the TUI transcript
- Persisting raw base64 image payloads in durable session storage
- HTTP/browser-side clipboard UX
- Drag-and-drop file support

## UX Model

### Editor Tokens

When the user presses `Ctrl+V` and the clipboard contains an image, the TUI inserts a token at the cursor:

`[Image 1: PNG 1440x900 620KB]`

That token is the editing affordance, not the source of truth. Internally the composer keeps a token-to-image map.

This gives users:

- visible evidence that an image was added
- natural deletion by removing the token
- natural reordering by moving the token in the text
- no separate attachment tray or overlay for the MVP

### Token Editing Semantics

- Exact recognized token present in the buffer: image remains attached
- Token removed from the buffer: image is removed from the pending prompt
- Token moved: image position moves with it
- Token text edited arbitrarily: attachment is dropped and the edited content becomes plain text

This is intentionally strict. It keeps parsing deterministic and avoids partial-token edge cases.

## Core Model

Add a structured prompt type to core code:

```ts
type PromptPart =
  | { type: "text"; text: string }
  | {
      type: "image";
      token: string;
      mimeType: string;
      data: string;
      width?: number;
      height?: number;
      byteLength?: number;
    };

interface PromptInput {
  parts: PromptPart[];
}
```

Derived helpers:

- `promptInputToPlainText(input)` for legacy procedure compatibility
- `promptInputDisplayText(input)` for run history / transcript rendering
- `promptInputAttachmentSummaries(input)` for replay and persistence

## Procedure Runtime Shape

Do not widen every procedure signature immediately.

Keep:

```ts
execute(prompt: string, ctx: ProcedureApi)
```

Add to `ProcedureApi`:

```ts
promptInput: {
  parts: PromptPart[];
  text: string;
  displayText: string;
  images: Array<{
    token: string;
    mimeType: string;
    width?: number;
    height?: number;
    byteLength?: number;
  }>;
}
```

This preserves compatibility while making structured prompts available to new procedures.

For the first cut:

- existing procedures still receive plain `prompt`
- `default` is the only procedure that forwards images to downstream ACP
- non-default procedures that see `ctx.promptInput.images.length > 0` should either ignore them safely or fail explicitly based on chosen policy

Recommended MVP policy:

- top-level `/default` and implicit default prompts accept images
- all other procedures reject image-bearing prompts with a clear user-facing error

That avoids silent loss and keeps scope bounded.

## ACP Mapping

### Inbound ACP

`nanoboss acp-server` should stop flattening prompt blocks to text.

Instead:

- parse incoming `PromptRequest.prompt: ContentBlock[]`
- preserve `text` and `image` block order
- convert to internal `PromptInput`
- derive plain text only for legacy call sites

### Outbound ACP

`DefaultConversationSession.prompt(...)` should accept structured prompt input and emit ordered ACP blocks:

- text parts become `{ type: "text", text }`
- image parts become `{ type: "image", mimeType, data, uri? }`

Order must match the internal `parts` array.

### Capability Gating

Capture downstream `promptCapabilities` from ACP `initialize`.

Behavior:

- if downstream agent supports images, forward image parts
- if not, reject the prompt before submission with a clear error

`nanoboss` ACP server should advertise `promptCapabilities.image = true` once inbound image handling exists.

## TUI Architecture

### Composer State

The TUI needs more than `editor.getText()`.

Add local composer state:

- current text buffer
- pending image records keyed by token id

On submission:

- parse the buffer into alternating text and token segments
- build `PromptInput.parts`

### Clipboard Boundary

Do not put OS clipboard code in core prompt logic.

Introduce a small interface:

```ts
interface ClipboardImageProvider {
  readImage(): Promise<ClipboardImage | undefined>;
}
```

Where `ClipboardImage` contains:

- `mimeType`
- `data` (base64)
- `width?`
- `height?`
- `byteLength`

Platform-specific implementations live at the edge:

- macOS implementation
- Linux implementation
- Windows implementation

Core TUI only depends on the interface.

### Cross-Platform Strategy

Preferred architecture:

- `src/tui/clipboard/provider.ts` defines interface and selection
- per-platform files implement host clipboard access
- unsupported platforms or failures return `undefined` and fall back to normal paste behavior

Important boundary:

- terminal bracketed paste handles text
- `Ctrl+V` image attach is an explicit clipboard read action
- this is not the same as arbitrary pasted stdin bytes

## HTTP Shape

HTTP should also move to structured prompt input so the service has one canonical ingestion format.

Recommended request shape:

```ts
{
  prompt?: string;
  promptInput?: PromptInputPayload;
}
```

Transition behavior:

- if `promptInput` exists, use it
- else treat `prompt` as legacy text-only input

This keeps old clients working while enabling structured prompts in the TUI.

## Persistence And Replay

Do not persist raw image base64 in durable cells or session metadata for the MVP.

Persist only:

- `displayText`
- attachment summaries
- token labels if useful for replay

Places to update:

- `run_started`
- `run_restored`
- session metadata
- stored cell input metadata

Transcript and history can then render user prompts like:

`Please inspect this screenshot [Image 1: PNG 1440x900 620KB]`

without retaining the full binary payload.

## Implementation Phases

### Phase 1: Core Prompt Model

- Add `PromptInput` / `PromptPart`
- Add parsing and rendering helpers
- Thread structured prompt ingestion through service boundaries
- Keep legacy plain-text compatibility

Acceptance criteria:

- service can accept structured prompt input
- plain-text callers still work unchanged
- `ctx.promptInput` is available to procedures

### Phase 2: Default-Only ACP Delivery

- Update downstream default session prompt path to emit ordered ACP content blocks
- Capture downstream prompt capabilities
- Reject image prompts for agents without image support
- Update ACP server inbound prompt parsing and outbound advertised capability

Acceptance criteria:

- a prompt with text-image-text reaches downstream ACP in order
- `default` path preserves image parts
- unsupported downstream agents fail early

### Phase 3: TUI Token UX

- Add clipboard provider abstraction
- Implement `Ctrl+V` image attach path
- Insert inline tokens into editor text
- Parse tokens back into structured prompt parts on submit
- Drop attachments when tokens are edited or removed

Acceptance criteria:

- `Ctrl+V` inserts an image token into the editor
- deleting the token removes the image
- moving the token changes part ordering
- normal text paste still behaves normally

### Phase 4: Persistence / Replay

- Persist display text and image summaries
- Update `run_started` / `run_restored` payloads
- Ensure restored sessions show image markers in past user turns

Acceptance criteria:

- session restore shows prompts with image markers
- no raw image payloads are stored durably

### Phase 5: Procedure Guardrails

- Reject image-bearing prompts for non-default procedures
- Add clear error messaging
- Optionally document how future procedures can opt in via `ctx.promptInput`

Acceptance criteria:

- `/default` accepts images
- `/review ...` or other procedures fail clearly if images are attached

## Validation Plan

### Unit Tests

- prompt token parsing to `PromptInput.parts`
- token deletion / mutation behavior
- `PromptInput` to ACP content block conversion
- ACP inbound block parsing to internal prompt model
- downstream capability gating
- non-default procedure rejection with images

### TUI Tests

- `Ctrl+V` image attach inserts token
- editor submission produces structured prompt input
- deleting token removes pending image
- moving token changes output order

### Service / HTTP Tests

- HTTP structured prompt round-trip
- legacy string prompt compatibility
- replay / restore uses display text with image summaries

### ACP Tests

- server accepts inbound image blocks
- default session emits interleaved text/image/text blocks
- image capability advertisement is present once enabled

## Risks

### 1. Token Parsing Complexity

If token parsing is too permissive, users can accidentally create malformed attachment state. Keep parsing strict and only recognize exact generated tokens.

### 2. Clipboard Portability

Cross-platform clipboard image access may vary substantially by OS. That is why the clipboard layer must stay isolated from core prompt logic.

### 3. Mixed Legacy / Structured Paths

Leaving some call sites string-based while others become structured can create drift. Mitigate by making `PromptInput` the canonical service-layer shape as early as possible.

### 4. Downstream Agent Variability

ACP supports ordered content blocks, but downstream agents may differ in how well they reason over interleaved text and images. The transport should preserve order regardless.

## Open Questions

1. Should non-default procedures reject image-bearing prompts immediately, or should specific procedures be allowed to inspect `ctx.promptInput` without forwarding images downstream?
2. Should HTTP support image uploads in the first implementation, or should structured prompt input be added there first with TUI as the only producer?
3. Do we want a hard cap on attached image count and total byte size in the TUI MVP?
4. Should edited token text always degrade to plain text, or should there be a more forgiving parser for trivial whitespace changes?

## Recommendation

Implement this as a structured-prompt refactor with a `default`-only forwarding policy.

The key design constraint is:

- inline image markers should be an editor UX
- structured prompt parts should be the canonical runtime model

That keeps the user experience simple while preserving correct ACP semantics and leaving room for future procedure-level support.
