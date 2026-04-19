import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  TuiExtensionContext,
  TuiExtensionMetadata,
  TuiExtensionScope,
} from "@nanoboss/tui-extension-sdk";

import {
  TuiExtensionRegistry,
  type TuiExtensionContextFactory,
} from "@nanoboss/tui-extension-catalog";

const tempHomes: string[] = [];
let originalHome: string | undefined;

beforeEach(() => {
  originalHome = process.env.HOME;
  process.env.HOME = mkdtempSync(join(tmpdir(), "nab-tui-ext-home-"));
  tempHomes.push(process.env.HOME);
});

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }

  while (tempHomes.length > 0) {
    const home = tempHomes.pop();
    if (home) {
      rmSync(home, { recursive: true, force: true });
    }
  }
});

interface CapturedActivation {
  metadata: TuiExtensionMetadata;
  scope: TuiExtensionScope;
}

function captureFactory(captured: CapturedActivation[]): {
  factory: TuiExtensionContextFactory;
  logs: { extensionName: string; level: "info" | "warning" | "error"; text: string }[];
} {
  const logs: { extensionName: string; level: "info" | "warning" | "error"; text: string }[] = [];
  const factory: TuiExtensionContextFactory = ({ metadata, scope }) => {
    captured.push({ metadata, scope });
    const ctx: TuiExtensionContext = {
      extensionName: metadata.name,
      scope,
      theme: {} as TuiExtensionContext["theme"],
      registerKeyBinding: () => {},
      registerChromeContribution: () => {},
      registerActivityBarSegment: () => {},
      registerPanelRenderer: () => {},
      log: {
        info: (text) => logs.push({ extensionName: metadata.name, level: "info", text }),
        warning: (text) => logs.push({ extensionName: metadata.name, level: "warning", text }),
        error: (text) => logs.push({ extensionName: metadata.name, level: "error", text }),
      },
    };
    return ctx;
  };
  return { factory, logs };
}

function writeExtensionFile(dir: string, name: string, options: {
  metadataName?: string;
  version?: string;
  description?: string;
  extraActivateBody?: string;
}): void {
  const metadataName = options.metadataName ?? name;
  const version = options.version ?? "1.0.0";
  const description = options.description ?? `extension ${metadataName}`;
  const body = options.extraActivateBody ?? "";
  writeFileSync(
    join(dir, `${name}.ts`),
    [
      "export default {",
      "  metadata: {",
      `    name: "${metadataName}",`,
      `    version: "${version}",`,
      `    description: "${description}",`,
      "  },",
      "  activate(ctx) {",
      body,
      "  },",
      "};",
      "",
    ].join("\n"),
    "utf8",
  );
}

describe("TuiExtensionRegistry", () => {
  test("discovers extensions from a single repo-style root", async () => {
    const root = mkdtempSync(join(tmpdir(), "nab-tui-ext-repo-"));
    writeExtensionFile(root, "alpha", {});
    writeExtensionFile(root, "beta", {});

    const registry = new TuiExtensionRegistry({ extensionRoots: [root] });
    await registry.loadFromDisk();

    expect(registry.listMetadata().map((entry) => entry.metadata.name)).toEqual([
      "alpha",
      "beta",
    ]);

    const captured: CapturedActivation[] = [];
    const { factory } = captureFactory(captured);
    await registry.activateAll(factory);

    expect(captured.map((c) => c.metadata.name)).toEqual(["alpha", "beta"]);
    expect(registry.listMetadata().every((entry) => entry.status === "active")).toBe(true);
  });

  test("discovers extensions from the profile root", async () => {
    const profileRoot = mkdtempSync(join(tmpdir(), "nab-tui-ext-profile-"));
    writeExtensionFile(profileRoot, "profiled", {});

    const registry = new TuiExtensionRegistry({
      extensionRoots: [profileRoot],
      profileExtensionRoot: profileRoot,
    });
    await registry.loadFromDisk();

    const listed = registry.listMetadata();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.metadata.name).toBe("profiled");
    expect(listed[0]?.scope).toBe("profile");
  });

  test("repo root shadows profile root for same extension name", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "nab-tui-ext-repo-"));
    const profileRoot = mkdtempSync(join(tmpdir(), "nab-tui-ext-profile-"));

    writeExtensionFile(repoRoot, "shared", {
      description: "repo copy",
    });
    writeExtensionFile(profileRoot, "shared", {
      description: "profile copy",
    });

    // Order matters for the test; but precedence is determined by scope rank,
    // not by roots order, so we pass profile first to prove scope precedence.
    const registry = new TuiExtensionRegistry({
      extensionRoots: [profileRoot, repoRoot],
      profileExtensionRoot: profileRoot,
    });
    await registry.loadFromDisk();

    const [entry] = registry.listMetadata();
    expect(entry?.scope).toBe("repo");
    expect(entry?.metadata.description).toBe("repo copy");
  });

  test("within a tier, extensions are ordered alphabetically by name", async () => {
    const root = mkdtempSync(join(tmpdir(), "nab-tui-ext-order-"));
    // Write in reverse alphabetical order to ensure the registry sorts.
    writeExtensionFile(root, "zeta-file", { metadataName: "zeta" });
    writeExtensionFile(root, "alpha-file", { metadataName: "alpha" });
    writeExtensionFile(root, "mu-file", { metadataName: "mu" });

    const registry = new TuiExtensionRegistry({ extensionRoots: [root] });
    await registry.loadFromDisk();

    expect(registry.listMetadata().map((entry) => entry.metadata.name)).toEqual([
      "alpha",
      "mu",
      "zeta",
    ]);
  });

  test("activate() failure is isolated; other extensions still activate", async () => {
    const root = mkdtempSync(join(tmpdir(), "nab-tui-ext-fail-"));
    writeExtensionFile(root, "healthy", {});
    writeExtensionFile(root, "broken", {
      extraActivateBody: "    throw new Error(\"boom\");",
    });
    writeExtensionFile(root, "trailing", {});

    const registry = new TuiExtensionRegistry({ extensionRoots: [root] });
    await registry.loadFromDisk();

    const captured: CapturedActivation[] = [];
    const { factory, logs } = captureFactory(captured);

    // activateAll must not throw even though one extension's activate throws.
    await registry.activateAll(factory);

    const statusByName = new Map(
      registry.listMetadata().map((entry) => [entry.metadata.name, entry]),
    );
    expect(statusByName.get("broken")?.status).toBe("failed");
    expect(statusByName.get("broken")?.error?.message).toContain("boom");
    expect(statusByName.get("healthy")?.status).toBe("active");
    expect(statusByName.get("trailing")?.status).toBe("active");

    // Failure is surfaced via the extension's logger.
    const brokenLogs = logs.filter(
      (log) => log.extensionName === "broken" && log.level === "error",
    );
    expect(brokenLogs.length).toBeGreaterThan(0);
    expect(brokenLogs.some((log) => log.text.includes("boom"))).toBe(true);
  });
});
