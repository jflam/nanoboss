// Test preload: activate the built-in TUI extensions (currently just
// `nanoboss-core-ui`, which contributes the `nb/card@1` panel renderer) before
// any test file's reducer path calls `getPanelRenderer("nb/card@1")`.
//
// We run a hermetic bootExtensions with no disk roots so user-local
// extensions under ~/.nanoboss/extensions don't leak into tests.
import { bootExtensions } from "../src/extensions/boot-extensions.ts";

await bootExtensions("/tmp/nanoboss-adapters-tui-tests", {
  extensionRoots: [],
  skipDisk: true,
  log: () => {},
});
