import type { Procedure } from "../src/core/types.ts";
import { executeAutoresearchLoopCommand } from "../src/autoresearch/runner.ts";

export default {
  name: "autoresearch-loop",
  description: "Run one deterministic autoresearch iteration and queue the next one if still active",
  async execute(prompt, ctx) {
    return await executeAutoresearchLoopCommand(prompt, ctx);
  },
} satisfies Procedure;
