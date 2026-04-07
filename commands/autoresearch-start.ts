import type { Procedure } from "../src/core/types.ts";
import { executeAutoresearchStartCommand } from "../src/autoresearch/runner.ts";

export default {
  name: "autoresearch-start",
  description: "Create a new autoresearch session and run a bounded foreground loop",
  inputHint: "Optimization goal",
  async execute(prompt, ctx) {
    return await executeAutoresearchStartCommand(prompt, ctx);
  },
} satisfies Procedure;
