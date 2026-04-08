import type { Procedure } from "../src/core/types.ts";

export default {
  name: "default",
  description: "Pass prompt through to the downstream agent",
  async execute(prompt, ctx) {
    const result = await ctx.continueDefaultSession(prompt);

    return {
      display: result.data,
    };
  },
} satisfies Procedure;
