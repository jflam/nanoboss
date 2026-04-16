import { expect, test } from "bun:test";
import * as procedureEngine from "@nanoboss/procedure-engine";

test("public entrypoint exports a smoke symbol", () => {
  expect(procedureEngine.formatErrorMessage).toBeDefined();
});
