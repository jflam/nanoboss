import { expect, test } from "bun:test";
import * as appRuntime from "@nanoboss/app-runtime";

test("public entrypoint exports a smoke symbol", () => {
  expect(appRuntime.shouldLoadDiskCommands).toBeDefined();
});
