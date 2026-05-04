import { expect, test } from "bun:test";
import * as appSupport from "@nanoboss/app-support";

test("public entrypoint exports a smoke symbol", () => {
  expect(appSupport.getBuildLabel).toBeDefined();
});

test("public entrypoint keeps implementation helpers internal", () => {
  expect("createTypiaBunPlugin" in appSupport).toBe(false);
  expect("splitPath" in appSupport).toBe(false);
});
