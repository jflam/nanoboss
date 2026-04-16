import { describe, expect, test } from "bun:test";

import { parseToolCardThemeCommand, shouldDisableEditorSubmit } from "@nanoboss/adapters-tui";

describe("tui commands", () => {
  test("keeps submit enabled for exit commands while a run is active", () => {
    expect(shouldDisableEditorSubmit(true, "/quit")).toBe(false);
    expect(shouldDisableEditorSubmit(true, "/exit")).toBe(false);
    expect(shouldDisableEditorSubmit(true, "/end")).toBe(false);
    expect(shouldDisableEditorSubmit(true, "/light")).toBe(false);
    expect(shouldDisableEditorSubmit(true, "/dark")).toBe(false);
    expect(shouldDisableEditorSubmit(true, "quit")).toBe(false);
    expect(shouldDisableEditorSubmit(true, "hello")).toBe(false);
    expect(shouldDisableEditorSubmit(true, "/new")).toBe(false);
  });

  test("disables submit for blank input while a run is active", () => {
    expect(shouldDisableEditorSubmit(true, "")).toBe(true);
    expect(shouldDisableEditorSubmit(true, "   ")).toBe(true);
  });

  test("leaves submit enabled when no run is active", () => {
    expect(shouldDisableEditorSubmit(false, "hello")).toBe(false);
    expect(shouldDisableEditorSubmit(false, "/quit")).toBe(false);
  });

  test("parses local tool card theme commands", () => {
    expect(parseToolCardThemeCommand("/dark")).toBe("dark");
    expect(parseToolCardThemeCommand("/light")).toBe("light");
    expect(parseToolCardThemeCommand("/model")).toBeUndefined();
  });
});
