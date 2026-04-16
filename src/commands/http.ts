import { startHttpServer } from "@nanoboss/adapters-http";
import { parseHttpServerOptions } from "./http-options.ts";

export async function runHttpCommand(argv: string[] = []): Promise<ReturnType<typeof Bun.serve>> {
  return await startHttpServer(parseHttpServerOptions(argv));
}
