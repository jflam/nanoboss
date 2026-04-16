import { expect, test } from "bun:test";
import * as procedureCatalog from "@nanoboss/procedure-catalog";

test("public entrypoint exports a smoke symbol", () => {
  expect(procedureCatalog.ProcedureRegistry).toBeDefined();
});
