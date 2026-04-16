import { expect, test } from "bun:test";
import * as procedureSdk from "@nanoboss/procedure-sdk";

test("public entrypoint exports a smoke symbol", () => {
  expect(procedureSdk.expectData).toBeDefined();
});
