import type { Procedure } from "../../src/core/types.ts";
import { executeAutoresearchStatusCommand } from "./runner.ts";

export default {
  name: "autoresearch-status",
  description: "Inspect the current repo-local autoresearch session",
  async execute(prompt, ctx) {
    return await executeAutoresearchStatusCommand(prompt, ctx);
  },
} satisfies Procedure;
