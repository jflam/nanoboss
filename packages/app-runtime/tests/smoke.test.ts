import { expect, test } from "bun:test";
import * as appRuntime from "@nanoboss/app-runtime";

test("public entrypoint exports a smoke symbol", () => {
  expect(appRuntime.NanobossService).toBeDefined();
  expect("shouldLoadDiskCommands" in appRuntime).toBe(false);
  expect("summarizeToolCallStart" in appRuntime).toBe(false);
  expect("summarizeToolCallUpdate" in appRuntime).toBe(false);
  expect("isCommandsUpdatedEvent" in appRuntime).toBe(false);
  expect("isRunFailedEvent" in appRuntime).toBe(false);
  expect("isTextDeltaEvent" in appRuntime).toBe(false);
  expect("isTokenUsageEvent" in appRuntime).toBe(false);
  expect("isToolStartedEvent" in appRuntime).toBe(false);
  expect("isToolUpdatedEvent" in appRuntime).toBe(false);
  expect("prependPromptInputText" in appRuntime).toBe(false);
  expect("collectUnsyncedProcedureMemoryCards" in appRuntime).toBe(false);
  expect("materializeProcedureMemoryCard" in appRuntime).toBe(false);
  expect("renderProcedureMemoryCardsSection" in appRuntime).toBe(false);
  expect("extractProcedureDispatchResult" in appRuntime).toBe(false);
  expect("isProcedureDispatchResult" in appRuntime).toBe(false);
  expect("isProcedureDispatchStatusResult" in appRuntime).toBe(false);
  expect("SessionEventLog" in appRuntime).toBe(false);
});

test("public entrypoint does not leak procedure-engine implementation classes", () => {
  expect("UiApiImpl" in appRuntime).toBe(false);
});
