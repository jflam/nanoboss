import type { Procedure } from "../src/core/types.ts";
import { executeAutoresearchStopCommand } from "../src/autoresearch/runner.ts";

export default {
  name: "autoresearch-stop",
  description: "Disable autoresearch continuation without deleting history",
  async execute(prompt, ctx) {
    return await executeAutoresearchStopCommand(prompt, ctx);
  },
} satisfies Procedure;
