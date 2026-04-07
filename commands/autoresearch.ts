import type { Procedure } from "../src/core/types.ts";
import { executeAutoresearchCommand } from "../src/autoresearch/runner.ts";

export default {
  name: "autoresearch",
  description: "Start, resume, or inspect a resumable autoresearch optimization loop",
  inputHint: "Goal text, `status`, or `resume`",
  async execute(prompt, ctx) {
    return await executeAutoresearchCommand(prompt, ctx);
  },
} satisfies Procedure;
