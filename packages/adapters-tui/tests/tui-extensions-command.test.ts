import { describe, expect, test } from "bun:test";

import type {
  TuiExtension,
} from "@nanoboss/tui-extension-sdk";
import { TuiExtensionRegistry } from "@nanoboss/tui-extension-catalog";

import {
  bootExtensions,
  NanobossTuiController,
  type NanobossTuiControllerDeps,
} from "@nanoboss/adapters-tui";
import { formatExtensionsCard } from "../src/extensions/command-extensions-card.ts";
import type { PanelRenderer } from "../src/core/panel-renderers.ts";
import type { TypeDescriptor } from "@nanoboss/procedure-sdk";

function makeRegistry(): TuiExtensionRegistry {
  return new TuiExtensionRegistry({
    cwd: "/tmp/nonexistent-extensions-command",
    extensionRoots: [],
  });
}

const STUB_SCHEMA: TypeDescriptor<Record<string, unknown>> = {
  schema: {},
  validate: (input): input is Record<string, unknown> =>
    typeof input === "object" && input !== null,
};

async function makeController(
  overrides: Partial<NanobossTuiControllerDeps> = {},
): Promise<{
  controller: NanobossTuiController;
  statuses: string[];
  getState: () => ReturnType<NanobossTuiController["getState"]>;
}> {
  const statuses: string[] = [];
  const controller = new NanobossTuiController(
    {
      serverUrl: "http://127.0.0.1:0",
      showToolCalls: false,
    },
    {
      onStateChange: (state) => {
        if (state.statusLine) statuses.push(state.statusLine);
      },
      onClearInput: () => {},
      ...overrides,
    },
  );
  return { controller, statuses, getState: () => controller.getState() };
}

describe("/extensions slash command", () => {
  test("lists a fixture extension with correct scope, status=active, and non-zero contribution counts", async () => {
    const registry = makeRegistry();
    const fixture: TuiExtension = {
      metadata: {
        name: "extcmd-active",
        version: "1.2.3",
        description: "fixture for /extensions active case",
      },
      activate(ctx) {
        ctx.registerKeyBinding({
          id: "ping",
          category: "custom",
          label: "extcmd ping",
          match: (data) => data === "\u0001extcmd-active-ping\u0001",
          run() { return { consume: true }; },
        });
        ctx.registerChromeContribution({
          id: "badge",
          slot: "footer",
          render: () => ({ __extcmd: true } as unknown as never),
        });
        const renderer: PanelRenderer<Record<string, unknown>> = {
          rendererId: "extcmd-active/unique@1",
          schema: STUB_SCHEMA,
          render({ payload }) { return payload as unknown as never; },
        };
        ctx.registerPanelRenderer(renderer);
      },
    };
    registry.registerBuiltinExtension(fixture);

    const result = await bootExtensions("/tmp/nonexistent-extensions-command", {
      registry,
      log: () => {},
    });

    const entries = result.registry.listMetadata();
    const entry = entries.find((e) => e.metadata.name === "extcmd-active");
    expect(entry).toBeDefined();
    expect(entry?.scope).toBe("builtin");
    expect(entry?.status).toBe("active");
    expect(entry?.contributions).toEqual({
      bindings: 1,
      chromeContributions: 1,
      activityBarSegments: 0,
      panelRenderers: 1,
    });

    // Controller dispatch now produces a `nb/card@1` procedure panel that
    // lands in the transcript (state.procedurePanels), not a status line.
    // Status-line emission was replaced because users could not see it.
    const { controller, getState } = await makeController({
      listExtensionEntries: () => result.registry.listMetadata(),
    });
    await controller.handleSubmit("/extensions");

    const panels = getState().procedurePanels;
    expect(panels).toHaveLength(1);
    const panel = panels[0]!;
    expect(panel.rendererId).toBe("nb/card@1");
    expect(panel.key).toBe("local:extensions");
    expect(panel.severity).toBe("info");
    const payload = panel.payload as { title: string; markdown: string };
    expect(payload.title).toBe("Extensions");
    expect(payload.markdown).toContain("extcmd-active");
    expect(payload.markdown).toContain("`builtin`");
    expect(payload.markdown).toContain("active");
    expect(payload.markdown).toContain("key bindings: 1");
    expect(payload.markdown).toContain("chrome contributions: 1");
    expect(payload.markdown).toContain("panel renderers: 1");

    // Transcript item is appended so the card is actually visible.
    const items = getState().transcriptItems;
    expect(items.some((it) => it.type === "procedure_panel" && it.id === panel.panelId)).toBe(true);
  });

  test("lists a failed extension with status=failed and the captured error message", async () => {
    const registry = makeRegistry();
    const broken: TuiExtension = {
      metadata: {
        name: "extcmd-broken",
        version: "0.0.1",
        description: "throws during activate",
      },
      activate() {
        throw new Error("activate kaboom");
      },
    };
    registry.registerBuiltinExtension(broken);

    const result = await bootExtensions("/tmp/nonexistent-extensions-command", {
      registry,
      log: () => {},
    });

    const entry = result.registry.listMetadata().find((e) => e.metadata.name === "extcmd-broken");
    expect(entry?.status).toBe("failed");
    expect(entry?.error?.message).toBe("activate kaboom");

    // `formatExtensionsCard` is the direct formatter behind the new
    // card-based slash command rendering. Asserting on it keeps the
    // test resilient to run-local concerns like transcript ordering.
    const card = formatExtensionsCard(result.registry.listMetadata());
    expect(card.severity).toBe("warn");
    expect(card.markdown).toContain("extcmd-broken");
    expect(card.markdown).toContain("failed");
    expect(card.markdown).toContain("error: activate kaboom");

  });

  test("formatExtensionsCard produces an empty-state payload when the registry is empty", () => {
    const card = formatExtensionsCard([]);
    expect(card.title).toBe("Extensions");
    expect(card.markdown).toContain("No extensions loaded");
    expect(card.severity).toBe("info");
  });

  test("running /extensions twice replaces the card in place via stable key", async () => {
    const registry = makeRegistry();
    registry.registerBuiltinExtension({
      metadata: { name: "extcmd-replace", version: "1.0.0", description: "replace" },
      activate() {},
    });
    const result = await bootExtensions("/tmp/nonexistent-extensions-command", {
      registry,
      log: () => {},
    });

    const { controller, getState } = await makeController({
      listExtensionEntries: () => result.registry.listMetadata(),
    });
    await controller.handleSubmit("/extensions");
    await controller.handleSubmit("/extensions");

    const panels = getState().procedurePanels;
    expect(panels).toHaveLength(1);
    expect(panels[0]!.key).toBe("local:extensions");
  });

  test("/extensions surfaces a visible error card when the registry is not wired in", async () => {
    // Omit listExtensionEntries entirely so the controller takes the
    // registry-unavailable branch.
    const { controller, getState } = await makeController();
    await controller.handleSubmit("/extensions");
    const panels = getState().procedurePanels;
    expect(panels).toHaveLength(1);
    expect(panels[0]!.severity).toBe("error");
    const payload = panels[0]!.payload as { markdown: string };
    expect(payload.markdown).toContain("registry is not available");
  });

  test("aggregate failure status is emitted via bootExtensions.aggregateStatus when >=1 extension fails", async () => {
    const registry = makeRegistry();
    registry.registerBuiltinExtension({
      metadata: { name: "extcmd-ok", version: "1.0.0", description: "ok" },
      activate() {},
    });
    registry.registerBuiltinExtension({
      metadata: { name: "extcmd-bad", version: "1.0.0", description: "bad" },
      activate() { throw new Error("nope"); },
    });

    const logs: { level: string; text: string }[] = [];
    const result = await bootExtensions("/tmp/nonexistent-extensions-command", {
      registry,
      log: (level, text) => logs.push({ level, text }),
    });

    expect(result.failedCount).toBe(1);
    expect(result.aggregateStatus).toBe("[extensions] 1 extension failed to activate");
    const aggregate = logs.find((entry) => entry.text === result.aggregateStatus);
    expect(aggregate?.level).toBe("error");
  });

  test("aggregate failure status is NOT emitted when every extension activates cleanly", async () => {
    const registry = makeRegistry();
    registry.registerBuiltinExtension({
      metadata: { name: "extcmd-ok1", version: "1.0.0", description: "ok1" },
      activate() {},
    });
    registry.registerBuiltinExtension({
      metadata: { name: "extcmd-ok2", version: "1.0.0", description: "ok2" },
      activate() {},
    });

    const logs: { level: string; text: string }[] = [];
    const result = await bootExtensions("/tmp/nonexistent-extensions-command", {
      registry,
      log: (level, text) => logs.push({ level, text }),
    });

    expect(result.failedCount).toBe(0);
    expect(result.aggregateStatus).toBeUndefined();
    const aggregateHit = logs.find((entry) => entry.text.includes("failed to activate"));
    expect(aggregateHit).toBeUndefined();
  });
});
