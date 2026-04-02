import { EventEmitter } from "node:events";

import { describe, expect, test } from "bun:test";

import { readPromptInput } from "../../cli.ts";

class FakePromptReader extends EventEmitter {
  promptCalls = 0;
  prompts: string[] = [];
  questionError?: Error;

  async question(query: string): Promise<string> {
    this.prompts.push(query);
    if (this.questionError) {
      throw this.questionError;
    }
    return "single line";
  }

  prompt(): void {
    this.promptCalls += 1;
  }

  setPrompt(prompt: string): void {
    this.prompts.push(prompt);
  }
}

describe("CLI multiline input", () => {
  test("falls back to readline.question when terminal multiline paste handling is disabled", async () => {
    const reader = new FakePromptReader();

    const line = await readPromptInput(reader, {
      prompt: "> ",
      useTerminalMultilinePaste: false,
    });

    expect(line).toBe("single line");
    expect(reader.prompts).toEqual(["> "]);
    expect(reader.promptCalls).toBe(0);
  });

  test("batches rapidly pasted terminal lines into one multi-line prompt", async () => {
    const reader = new FakePromptReader();
    const pending = readPromptInput(reader, {
      prompt: "> ",
      debounceMs: 5,
      useTerminalMultilinePaste: true,
    });

    reader.emit("line", "alpha");
    reader.emit("line", "beta");
    reader.emit("line", "gamma");

    await expect(pending).resolves.toBe("alpha\nbeta\ngamma");
    expect(reader.prompts).toEqual(["> "]);
    expect(reader.promptCalls).toBe(1);
  });

  test("normalizes readline close errors for non-terminal prompt reading", async () => {
    const reader = new FakePromptReader();
    const error = new Error("Interface is closed");
    (error as Error & { code?: string }).code = "ERR_USE_AFTER_CLOSE";
    reader.questionError = error;

    await expect(readPromptInput(reader, {
      prompt: "> ",
      useTerminalMultilinePaste: false,
    })).rejects.toThrow("readline was closed");
  });

  test("rejects with a stable close error when terminal input closes before any line", async () => {
    const reader = new FakePromptReader();
    const pending = readPromptInput(reader, {
      prompt: "> ",
      debounceMs: 5,
      useTerminalMultilinePaste: true,
    });

    reader.emit("close");

    await expect(pending).rejects.toThrow("readline was closed");
  });
});
