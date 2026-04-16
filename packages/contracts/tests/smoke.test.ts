import { expect, test } from "bun:test";
import * as contracts from "@nanoboss/contracts";

test("public entrypoint exports a smoke symbol", () => {
  expect(contracts.createRunRef).toBeDefined();
});
