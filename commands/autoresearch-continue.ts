import type { Procedure } from "../src/core/types.ts";
import { executeAutoresearchContinueCommand } from "../src/autoresearch/runner.ts";

export default {
  name: "autoresearch-continue",
  description: "Continue the repo-local autoresearch session in the foreground",
  inputHint: "Optional continuation note",
  async execute(prompt, ctx) {
    return await executeAutoresearchContinueCommand(prompt, ctx);
  },
} satisfies Procedure;
