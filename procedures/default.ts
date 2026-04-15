import { createTextPromptInput, type Procedure } from "@nanoboss/procedure-sdk";

export default {
  name: "default",
  description: "Pass prompt through to the downstream agent",
  async execute(prompt, ctx) {
    const promptInput = ctx.promptInput ?? {
      parts: createTextPromptInput(prompt).parts,
      text: prompt,
      displayText: prompt,
      images: [],
    };
    const result = await ctx.agent.run(prompt, {
      session: "default",
      promptInput: {
        parts: promptInput.parts,
      },
    });

    return {
      display: result.data,
    };
  },
} satisfies Procedure;
