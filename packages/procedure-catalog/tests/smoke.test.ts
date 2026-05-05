import { expect, test } from "bun:test";
import * as procedureCatalog from "@nanoboss/procedure-catalog";

test("public entrypoint exports a smoke symbol", () => {
  expect(procedureCatalog.ProcedureRegistry).toBeDefined();
});

test("public entrypoint keeps registry discovery internals private", () => {
  expect("discoverDiskProcedures" in procedureCatalog).toBe(false);
});
