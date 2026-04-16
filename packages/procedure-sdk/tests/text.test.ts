import { describe, expect, test } from "bun:test";

import { summarizeText } from "@nanoboss/procedure-sdk";

describe("summarizeText", () => {
  test("compacts whitespace before truncating", () => {
    expect(summarizeText("  one\n\n two   three  ", 11)).toBe("one two...");
  });

  test("returns an empty string for blank input", () => {
    expect(summarizeText(" \n\t ")).toBe("");
  });
});
