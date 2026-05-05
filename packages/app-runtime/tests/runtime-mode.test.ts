import { describe, expect, test } from "bun:test";

import { shouldLoadDiskCommands } from "../src/runtime-mode.ts";

describe("shouldLoadDiskCommands", () => {
  test("defaults to loading commands from disk", () => {
    const previous = Bun.env.NANOBOSS_LOAD_DISK_COMMANDS;
    delete Bun.env.NANOBOSS_LOAD_DISK_COMMANDS;

    try {
      expect(shouldLoadDiskCommands()).toBe(true);
    } finally {
      if (previous === undefined) {
        delete Bun.env.NANOBOSS_LOAD_DISK_COMMANDS;
      } else {
        Bun.env.NANOBOSS_LOAD_DISK_COMMANDS = previous;
      }
    }
  });

  test("allows disk command loading to be disabled explicitly", () => {
    const previous = Bun.env.NANOBOSS_LOAD_DISK_COMMANDS;
    Bun.env.NANOBOSS_LOAD_DISK_COMMANDS = "0";

    try {
      expect(shouldLoadDiskCommands()).toBe(false);
    } finally {
      if (previous === undefined) {
        delete Bun.env.NANOBOSS_LOAD_DISK_COMMANDS;
      } else {
        Bun.env.NANOBOSS_LOAD_DISK_COMMANDS = previous;
      }
    }
  });
});
