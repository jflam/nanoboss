import { expect, test } from "bun:test";
import * as adaptersHttp from "@nanoboss/adapters-http";

test("public entrypoint exports a smoke symbol", () => {
  expect(adaptersHttp.getServerHealth).toBeDefined();
});
