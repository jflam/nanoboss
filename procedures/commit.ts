import type { Procedure } from "../src/core/types.ts";

export default {
  name: "commit",
  description: "Git commit staged or recent changes with a descriptive message",
  async execute(prompt, ctx) {
    const result = await ctx.callAgent(
      `Git commit the changes in ${ctx.cwd} with a descriptive message. Context: ${prompt}`,
      { stream: false },
    );

    if (!result.dataRef) {
      throw new Error("Missing commit data ref");
    }

    return {
      data: {
        commit: result.dataRef,
      },
      display: result.data,
      summary: prompt ? `commit: ${prompt}` : "commit",
    };
  },
} satisfies Procedure;
