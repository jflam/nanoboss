import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { readNanobossSettings } from "@nanoboss/store";

let tempHome: string | undefined;

afterEach(() => {
  if (tempHome) {
    rmSync(tempHome, { recursive: true, force: true });
    tempHome = undefined;
  }
});

describe("readNanobossSettings", () => {
  test("throws when settings.json contains malformed JSON", () => {
    const originalHome = process.env.HOME;
    tempHome = mkdtempSync(join(tmpdir(), "nanoboss-settings-"));
    process.env.HOME = tempHome;

    try {
      mkdirSync(join(tempHome, ".nanoboss"), { recursive: true });
      writeFileSync(join(tempHome, ".nanoboss", "settings.json"), "{bad json\n", "utf8");

      expect(() => readNanobossSettings()).toThrow("Failed to read nanoboss settings");
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
  });
});
