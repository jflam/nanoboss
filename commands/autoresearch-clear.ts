import type { Procedure } from "../src/core/types.ts";
import { executeAutoresearchClearCommand } from "../src/autoresearch/runner.ts";

export default {
  name: "autoresearch-clear",
  description: "Delete repo-local autoresearch state after the loop is stopped",
  async execute(prompt, ctx) {
    return await executeAutoresearchClearCommand(prompt, ctx);
  },
} satisfies Procedure;
