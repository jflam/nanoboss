import { expect, test } from "bun:test";
import * as appSupport from "@nanoboss/app-support";

test("public entrypoint exports a smoke symbol", () => {
  expect(appSupport.getBuildLabel).toBeDefined();
});
