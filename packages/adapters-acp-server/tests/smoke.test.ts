import { expect, test } from "bun:test";
import * as adaptersAcpServer from "@nanoboss/adapters-acp-server";

test("public entrypoint exports a smoke symbol", () => {
  expect(adaptersAcpServer.runAcpServerCommand).toBeDefined();
});
