import { expect, test } from "bun:test";
import * as adaptersTui from "@nanoboss/adapters-tui";

test("public entrypoint exports a smoke symbol", () => {
  expect(adaptersTui.canUseNanobossTui).toBeDefined();
  expect("TranscriptComponent" in adaptersTui).toBe(false);
  expect("SelectOverlay" in adaptersTui).toBe(false);
  expect("promptWithSelectList" in adaptersTui).toBe(false);
  expect("renderNbCardV1Markdown" in adaptersTui).toBe(false);
  expect("createNbCardV1Renderer" in adaptersTui).toBe(false);
  expect("NbCardV1PayloadType" in adaptersTui).toBe(false);
});
