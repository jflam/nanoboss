import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const EXPECTED_RUNTIME_EXPORTS = [
  "RunCancelledError",
  "buildImageTokenLabel",
  "createTaggedJsonLineStream",
  "createTextPromptInput",
  "defaultCancellationMessage",
  "expectData",
  "expectDataRef",
  "formatAgentBanner",
  "formatErrorMessage",
  "hasPromptInputContent",
  "hasPromptInputImages",
  "jsonType",
  "normalizePromptInput",
  "normalizeRunCancelledError",
  "parsePromptInputPayload",
  "promptInputAttachmentSummaries",
  "promptInputDisplayText",
  "promptInputToPlainText",
  "summarizeText",
] as const;

test("package entrypoint resolves through built artifacts with a stable runtime export surface", async () => {
  const builtEntrypointPath = resolve(import.meta.dir, "../dist/index.js");
  const builtTypesPath = resolve(import.meta.dir, "../dist/index.d.ts");

  expect(existsSync(builtEntrypointPath)).toBe(true);
  expect(existsSync(builtTypesPath)).toBe(true);

  const builtModule = await import("../dist/index.js");
  const packageModule = await import("@nanoboss/procedure-sdk");
  const builtExports = Object.keys(builtModule).sort();

  expect(builtExports).toEqual([...EXPECTED_RUNTIME_EXPORTS].sort());
  expect(Object.keys(packageModule).sort()).toEqual(builtExports);
});
