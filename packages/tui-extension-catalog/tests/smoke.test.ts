import { expect, test } from "bun:test";
import * as tuiExtensionCatalog from "@nanoboss/tui-extension-catalog";

test("public entrypoint exports TuiExtensionRegistry", () => {
  expect(tuiExtensionCatalog.TuiExtensionRegistry).toBeDefined();
});
