import { describe, expect, test } from "bun:test";
import type { ChromeSlotId } from "@nanoboss/tui-extension-sdk";

import {
  createInitialUiState,
  createNanobossTuiTheme,
  NanobossAppView,
} from "@nanoboss/adapters-tui";
import {
  getChromeContributions,
  registerChromeContribution,
  type ChromeContribution,
} from "../src/core/chrome.ts";

function stripAnsi(text: string): string {
  const esc = String.fromCharCode(27);
  let result = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (ch === esc && text.charAt(i + 1) === "[") {
      let cursor = i + 2;
      while (cursor < text.length) {
        const code = text.charCodeAt(cursor);
        if ((code < 48 || code > 57) && code !== 59) break;
        cursor += 1;
      }
      if (text.charAt(cursor) === "m") {
        i = cursor;
        continue;
      }
    }
    result += ch;
  }
  return result;
}

describe("chrome registry", () => {
  test("core contributions are registered and reach every slot we expect", () => {
    const coreSlots = [
      "header",
      "session",
      "status",
      "transcriptAbove",
      "transcript",
      "composerBelow",
      "activityBar",
      "footer",
    ] as const satisfies readonly ChromeSlotId[];
    const ids = new Set(
      coreSlots.flatMap((slot) => getChromeContributions(slot).map((c) => c.id)),
    );
    expect(ids.has("core.header")).toBe(true);
    expect(ids.has("core.session")).toBe(true);
    expect(ids.has("core.status")).toBe(true);
    expect(ids.has("core.transcriptAbove.spacer")).toBe(true);
    expect(ids.has("core.transcript")).toBe(true);
    expect(ids.has("core.composerBelow.spacer")).toBe(true);
    expect(ids.has("core.activityBar")).toBe(true);
    expect(ids.has("core.footer")).toBe(true);
  });

  test("registerChromeContribution rejects duplicate ids", () => {
    const contribution: ChromeContribution = {
      id: "core.header",
      slot: "header",
      render: () => ({ render: () => [], invalidate: () => {} }),
    };
    expect(() => registerChromeContribution(contribution)).toThrow(/already registered/);
  });

  test("order field determines contribution order within a slot", () => {
    const suffix = Math.random().toString(36).slice(2);
    const aId = `test.order.a.${suffix}`;
    const bId = `test.order.b.${suffix}`;
    registerChromeContribution({
      id: bId,
      slot: "transcriptBelow",
      order: 10,
      render: () => ({ render: () => [], invalidate: () => {} }),
    });
    registerChromeContribution({
      id: aId,
      slot: "transcriptBelow",
      order: 0,
      render: () => ({ render: () => [], invalidate: () => {} }),
    });

    const slotContribs = getChromeContributions("transcriptBelow").map((c) => c.id);
    const idxA = slotContribs.indexOf(aId);
    const idxB = slotContribs.indexOf(bId);
    expect(idxA).toBeGreaterThanOrEqual(0);
    expect(idxB).toBeGreaterThanOrEqual(0);
    expect(idxA).toBeLessThan(idxB);
  });

  test("shouldRender gate hides contribution output at render time", () => {
    const suffix = Math.random().toString(36).slice(2);
    const id = `test.gate.${suffix}`;
    registerChromeContribution({
      id,
      slot: "composerAbove",
      render: () => ({
        render: () => ["__gated_marker__"],
        invalidate: () => {},
      }),
      shouldRender: (state) => state.inputDisabled,
    });

    const theme = createNanobossTuiTheme();
    const hiddenView = new NanobossAppView(
      { render: () => [""], invalidate: () => {} } as never,
      theme,
      {
        ...createInitialUiState({ cwd: "/repo" }),
        sessionId: "session-1",
        inputDisabled: false,
      },
    );
    const visibleView = new NanobossAppView(
      { render: () => [""], invalidate: () => {} } as never,
      theme,
      {
        ...createInitialUiState({ cwd: "/repo" }),
        sessionId: "session-1",
        inputDisabled: true,
        inputDisabledReason: "run",
      },
    );

    expect(stripAnsi(hiddenView.render(120).join("\n"))).not.toContain("__gated_marker__");
    expect(stripAnsi(visibleView.render(120).join("\n"))).toContain("__gated_marker__");
  });

  test("registered contribution output appears in NanobossAppView render", () => {
    const suffix = Math.random().toString(36).slice(2);
    const id = `test.custom.footer.${suffix}`;
    registerChromeContribution({
      id,
      slot: "footer",
      order: 100,
      render: () => ({
        render: () => ["__custom_footer_marker__"],
        invalidate: () => {},
      }),
    });

    const view = new NanobossAppView(
      { render: () => [""], invalidate: () => {} } as never,
      createNanobossTuiTheme(),
      { ...createInitialUiState({ cwd: "/repo" }), sessionId: "session-1" },
    );

    expect(stripAnsi(view.render(120).join("\n"))).toContain("__custom_footer_marker__");
  });
});
