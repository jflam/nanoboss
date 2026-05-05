import { describe, expect, test } from "bun:test";

import {
  parseModelSelectionCommand,
  parseToolCardThemeCommand,
  shouldDisableEditorSubmit,
} from "../src/app/commands.ts";

describe("tui commands", () => {
  test("keeps submit enabled for exit commands while a run is active", () => {
    expect(shouldDisableEditorSubmit(true, "run", "/quit")).toBe(false);
    expect(shouldDisableEditorSubmit(true, "run", "/exit")).toBe(false);
    expect(shouldDisableEditorSubmit(true, "run", "/end")).toBe(false);
    expect(shouldDisableEditorSubmit(true, "run", "/light")).toBe(false);
    expect(shouldDisableEditorSubmit(true, "run", "/dark")).toBe(false);
    expect(shouldDisableEditorSubmit(true, "run", "quit")).toBe(false);
    expect(shouldDisableEditorSubmit(true, "run", "hello")).toBe(false);
    expect(shouldDisableEditorSubmit(true, "run", "/new")).toBe(false);
  });

  test("disables submit for blank input while a run is active", () => {
    expect(shouldDisableEditorSubmit(true, "run", "")).toBe(true);
    expect(shouldDisableEditorSubmit(true, "run", "   ")).toBe(true);
  });

  test("disables submit for all input during a local busy state", () => {
    expect(shouldDisableEditorSubmit(true, "local", "")).toBe(true);
    expect(shouldDisableEditorSubmit(true, "local", "hello")).toBe(true);
  });

  test("leaves submit enabled when no run is active", () => {
    expect(shouldDisableEditorSubmit(false, undefined, "hello")).toBe(false);
    expect(shouldDisableEditorSubmit(false, undefined, "/quit")).toBe(false);
  });

  test("parses local tool card theme commands", () => {
    expect(parseToolCardThemeCommand("/dark")).toBe("dark");
    expect(parseToolCardThemeCommand("/light")).toBe("light");
    expect(parseToolCardThemeCommand("/model")).toBeUndefined();
  });

  test("parses inline /model commands syntactically before async validation", () => {
    expect(parseModelSelectionCommand("/model copilot not-in-catalog")).toEqual({
      provider: "copilot",
      model: "not-in-catalog",
    });
    expect(parseModelSelectionCommand("/model nope gpt-5.4")).toBeUndefined();
    expect(parseModelSelectionCommand("/model copilot")).toBeUndefined();
  });
});
