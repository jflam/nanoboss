import { expect, test } from "bun:test";
import type { TypeDescriptor } from "@nanoboss/procedure-sdk";
import * as tuiExtensionSdk from "@nanoboss/tui-extension-sdk";
import type {
  ActivityBarSegment,
  ChromeContribution,
  Component,
  KeyBinding,
  PanelRenderer,
  TuiExtension,
} from "@nanoboss/tui-extension-sdk";

interface SmokePayload {
  message: string;
}

const smokePayloadType: TypeDescriptor<SmokePayload> = {
  schema: { type: "object" },
  validate(input: unknown): input is SmokePayload {
    return typeof input === "object"
      && input !== null
      && typeof (input as { message?: unknown }).message === "string";
  },
};

class SmokeComponent implements Component {
  constructor(private readonly text: string) {}

  render(): string[] {
    return [this.text];
  }

  invalidate(): void {}
}

test("tui-extension-sdk public entrypoint loads as a types-only module", () => {
  // This package exports only types, so the runtime namespace object should
  // resolve successfully but carry no runtime bindings.
  expect(tuiExtensionSdk).toBeDefined();
  expect(typeof tuiExtensionSdk).toBe("object");
  expect(Object.keys(tuiExtensionSdk)).toHaveLength(0);
});

test("extension authoring contracts compile from the SDK package only", () => {
  const panel: PanelRenderer<SmokePayload> = {
    rendererId: "acme/smoke@1",
    schema: smokePayloadType,
    render: ({ payload, theme }) => new SmokeComponent(theme.accent(payload.message)),
  };

  const chrome: ChromeContribution = {
    id: "status",
    slot: "status",
    render: ({ theme, state }) => new SmokeComponent(theme.muted(state.sessionId)),
  };

  const activity: ActivityBarSegment = {
    id: "activity",
    line: "identity",
    render: ({ state, theme }) => theme.accent(state.cwd),
  };

  const binding: KeyBinding = {
    id: "ping",
    match: (data) => data === "\u0001sdk-smoke\u0001",
    category: "custom",
    label: "sdk smoke",
    run: ({ state }) => ({ consume: state.inputDisabled === false }),
  };

  const extension: TuiExtension = {
    metadata: {
      name: "acme-smoke",
      version: "1.0.0",
      description: "SDK-only authoring smoke test",
    },
    activate(ctx) {
      ctx.registerPanelRenderer(panel);
      ctx.registerChromeContribution(chrome);
      ctx.registerActivityBarSegment(activity);
      ctx.registerKeyBinding(binding);
    },
  };

  expect(extension.metadata.name).toBe("acme-smoke");
});
