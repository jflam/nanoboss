import { expect, test } from "bun:test";
import * as tuiExtensionCatalog from "@nanoboss/tui-extension-catalog";

test("public entrypoint exports TuiExtensionRegistry", () => {
  expect(tuiExtensionCatalog.TuiExtensionRegistry).toBeDefined();
});

test("public entrypoint keeps disk loading internals private", () => {
  expect("discoverDiskTuiExtensions" in tuiExtensionCatalog).toBe(false);
  expect("loadTuiExtensionFromPath" in tuiExtensionCatalog).toBe(false);
  expect("assertTuiExtension" in tuiExtensionCatalog).toBe(false);
});
