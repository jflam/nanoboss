import { expect, test } from "bun:test";
import * as adaptersTui from "@nanoboss/adapters-tui";

test("public entrypoint exports a smoke symbol", () => {
  expect(adaptersTui.canUseNanobossTui).toBeDefined();
});
