import { expect, test } from "bun:test";
import * as procedureEngine from "@nanoboss/procedure-engine";

test("public entrypoint exports a smoke symbol", () => {
  expect(procedureEngine.executeProcedure).toBeDefined();
  expect(procedureEngine.inferDataShape({ ok: true })).toEqual({ ok: "boolean" });
  expect(procedureEngine.stringifyCompactShape({ ok: "boolean" })).toBe("{\"ok\":\"boolean\"}");
});
