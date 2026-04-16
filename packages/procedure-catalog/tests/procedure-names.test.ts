import { describe, expect, test } from "bun:test";

import {
  normalizeProcedureName,
  resolveProcedureEntryRelativePath,
  resolveProcedureImportPrefix,
} from "@nanoboss/procedure-catalog";

describe("procedure name helpers", () => {
  test("normalizes slash-delimited procedure names", () => {
    expect(normalizeProcedureName(" /KB//Answer/ ")).toBe("kb/answer");
  });

  test("rejects invalid path segments", () => {
    expect(() => normalizeProcedureName("review///...")).toThrow("Procedure name segment was invalid");
  });

  test("maps canonical names to persisted entrypoint paths", () => {
    expect(resolveProcedureEntryRelativePath("review")).toBe("review.ts");
    expect(resolveProcedureEntryRelativePath("kb/answer")).toBe("kb/answer.ts");
  });

  test("computes src import prefixes from scope depth", () => {
    expect(resolveProcedureImportPrefix("review")).toBe("../../");
    expect(resolveProcedureImportPrefix("kb/answer")).toBe("../../../");
  });
});
