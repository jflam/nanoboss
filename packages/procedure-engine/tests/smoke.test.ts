import { expect, test } from "bun:test";
import * as procedureEngine from "@nanoboss/procedure-engine";

test("public entrypoint exports a smoke symbol", () => {
  expect(procedureEngine.executeProcedure).toBeDefined();
  expect("inferDataShape" in procedureEngine).toBe(false);
  expect("stringifyCompactShape" in procedureEngine).toBe(false);
  expect("resolveSelfCommand" in procedureEngine).toBe(false);
  expect("resolveSelfCommandWithRuntime" in procedureEngine).toBe(false);
});
