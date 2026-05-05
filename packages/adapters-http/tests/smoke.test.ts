import { expect, test } from "bun:test";
import * as adaptersHttp from "@nanoboss/adapters-http";

test("public entrypoint exports a smoke symbol", () => {
  expect(adaptersHttp.getServerHealth).toBeDefined();
});

test("public entrypoint keeps server parsing and supervisor test seams internal", () => {
  expect("parseSessionPromptRequestBody" in adaptersHttp).toBe(false);
  expect("parseSseStream" in adaptersHttp).toBe(false);
  expect("matchesServerBuild" in adaptersHttp).toBe(false);
  expect("describeWorkspaceMismatch" in adaptersHttp).toBe(false);
  expect("SessionEventLog" in adaptersHttp).toBe(false);
  expect("buildTurnDisplay" in adaptersHttp).toBe(false);
  expect("isCommandsUpdatedEvent" in adaptersHttp).toBe(false);
  expect("isRunFailedEvent" in adaptersHttp).toBe(false);
  expect("isTextDeltaEvent" in adaptersHttp).toBe(false);
  expect("isTokenUsageEvent" in adaptersHttp).toBe(false);
  expect("isToolStartedEvent" in adaptersHttp).toBe(false);
  expect("isToolUpdatedEvent" in adaptersHttp).toBe(false);
});
