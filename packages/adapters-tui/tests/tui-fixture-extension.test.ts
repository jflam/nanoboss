import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  bootExtensions,
  createInitialUiState,
} from "@nanoboss/adapters-tui";
import type {
  KeyBindingController,
  KeyBindingEditor,
} from "@nanoboss/tui-extension-sdk";
import {
  dispatchKeyBinding,
  listKeyBindings,
  type BindingCtx,
  type KeyBindingAppHooks,
} from "../src/core/bindings.ts";
import { getChromeContributions } from "../src/core/chrome.ts";

// The fixture lives under <repo>/tests/fixtures/extensions/acme-hello/ and
// carries its own .nanoboss/extensions entry. Pointing bootExtensions at
// that cwd runs the full discover → compile (Bun.build + typia plugin) →
// import → activate pipeline end-to-end with the real disk loader.
const FIXTURE_CWD = resolve(
  fileURLToPath(new URL("../../../tests/fixtures/extensions/acme-hello/", import.meta.url)),
);
const FIXTURE_EXTENSION_ROOT = join(FIXTURE_CWD, ".nanoboss", "extensions");

let originalHome: string | undefined;
let tempHome: string | undefined;

beforeAll(() => {
  // Isolate the runtime build cache at ~/.nanoboss/runtime/ per test file
  // so this suite neither reads from nor writes to a developer's real
  // nanoboss profile during the compile step.
  originalHome = process.env.HOME;
  tempHome = mkdtempSync(join(tmpdir(), "nab-acme-hello-home-"));
  process.env.HOME = tempHome;
});

afterAll(() => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  if (tempHome) {
    rmSync(tempHome, { recursive: true, force: true });
  }
});

function makeBindingCtx(): BindingCtx {
  const controller: KeyBindingController = {
    toggleToolOutput() {},
    toggleToolCardsHidden() {},
    toggleSimplify2AutoApprove() {},
        showLocalCard() {},
    cancelActiveRun() {},
    queuePrompt() {},
  };
  const editor: KeyBindingEditor = {
    getText: () => "",
    isShowingAutocomplete: () => false,
  };
  const app: KeyBindingAppHooks = {
    handleCtrlC: () => false,
    handleCtrlVImagePaste: async () => {},
    handleCtrlOWithCooldown() {},
    toggleLiveUpdatesPaused() {},
    handleTabQueue: () => false,
  };
  return {
    controller,
    editor,
    app,
    state: createInitialUiState({ cwd: FIXTURE_CWD }),
  };
}

describe("acme-hello fixture extension (end-to-end)", () => {
  test("disk discovery + compile + activate exposes the namespaced keybinding and chrome contribution", async () => {
    const logs: { level: string; text: string }[] = [];

    const result = await bootExtensions(FIXTURE_CWD, {
      // Point the disk loader directly at the fixture's extension root so
      // discovery does not depend on git repo detection. Skip builtins so
      // any shadow warnings from earlier test-preload registrations don't
      // pollute this assertion.
      extensionRoots: [FIXTURE_EXTENSION_ROOT],
      skipBuiltins: true,
      log: (level, text) => logs.push({ level, text }),
    });

    const acme = result.registry
      .listMetadata()
      .find((entry) => entry.metadata.name === "acme-hello");
    expect(acme).toBeDefined();
    expect(acme?.scope).toBe("repo");
    expect(acme?.status).toBe("active");
    expect(acme?.contributions).toEqual({
      bindings: 1,
      chromeContributions: 1,
      activityBarSegments: 0,
      panelRenderers: 0,
    });

    // The fixture's local "greet" id must be namespaced as "acme-hello/greet"
    // in the key-binding registry, and the bare id must not leak through.
    const bindingIds = listKeyBindings().map((binding) => binding.id);
    expect(bindingIds).toContain("acme-hello/greet");
    expect(bindingIds).not.toContain("greet");

    const dispatch = dispatchKeyBinding("\u0001acme-hello-greet\u0001", makeBindingCtx());
    expect(dispatch).toEqual({ consume: true });

    // Chrome contribution must land in the requested slot under its
    // namespaced id.
    const footerIds = getChromeContributions("footer").map((contribution) => contribution.id);
    expect(footerIds).toContain("acme-hello/badge");
    expect(footerIds).not.toContain("badge");

    // No extension failures: aggregate status must not be emitted.
    expect(result.failedCount).toBe(0);
    expect(result.aggregateStatus).toBeUndefined();

    // ctx.log.info from the fixture flows through the boot log router.
    const infoHit = logs.find(
      (entry) => entry.level === "info" && entry.text.includes("[acme-hello]") && entry.text.includes("activated"),
    );
    expect(infoHit).toBeDefined();
  });
});
