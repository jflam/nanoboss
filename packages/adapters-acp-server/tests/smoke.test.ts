import { expect, test } from "bun:test";
import * as adaptersAcpServer from "@nanoboss/adapters-acp-server";

test("public entrypoint exports a smoke symbol", () => {
  expect(adaptersAcpServer.runAcpServerCommand).toBeDefined();
});

test("public entrypoint only exposes the command entrypoint", () => {
  expect(Object.keys(adaptersAcpServer).sort()).toEqual(["runAcpServerCommand"]);
});
