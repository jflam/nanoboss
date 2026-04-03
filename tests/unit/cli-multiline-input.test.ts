import { describe, expect, test } from "bun:test";

import { readPromptInput } from "../../src/http-cli-legacy.ts";

class FakePromptReader {
  prompts: string[] = [];
  questionError?: Error;

  async question(query: string): Promise<string> {
    this.prompts.push(query);
    if (this.questionError) {
      throw this.questionError;
    }
    return "single line";
  }
}

describe("CLI prompt input", () => {
  test("reads one line through readline.question", async () => {
    const reader = new FakePromptReader();

    const line = await readPromptInput(reader, {
      prompt: "> ",
    });

    expect(line).toBe("single line");
    expect(reader.prompts).toEqual(["> "]);
  });

  test("normalizes readline close errors", async () => {
    const reader = new FakePromptReader();
    const error = new Error("Interface is closed");
    (error as Error & { code?: string }).code = "ERR_USE_AFTER_CLOSE";
    reader.questionError = error;

    await expect(readPromptInput(reader, {
      prompt: "> ",
    })).rejects.toThrow("readline was closed");
  });
});
