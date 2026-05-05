import { expect, test } from "bun:test";
import * as store from "@nanoboss/store";

test("public entrypoint exports a smoke symbol", () => {
  expect(store.SessionStore).toBeDefined();
  expect("formatTimestamp" in store).toBe(false);
});
