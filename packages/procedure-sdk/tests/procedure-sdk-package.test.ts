import { expect, test } from "bun:test";

import {
  createTextPromptInput,
  expectData,
  expectDataRef,
  jsonType,
  normalizePromptInput,
  promptInputAttachmentSummaries,
  promptInputDisplayText,
  promptInputToPlainText,
  type AgentInvocationApi,
  type CommandCallAgentOptions,
  type KernelValue,
  type Procedure,
  type ProcedureApi,
  type ProcedurePromptInput,
  type ProcedureResult,
  type RunResult,
  type TypeDescriptor,
} from "@nanoboss/procedure-sdk";

interface ExampleData {
  title: string;
  promptText: string;
  attachmentCount: number;
}

const ExampleDataType = jsonType<ExampleData>(
  {
    type: "object",
    properties: {
      title: { type: "string" },
      promptText: { type: "string" },
      attachmentCount: { type: "number" },
    },
    required: ["title", "promptText", "attachmentCount"],
  },
  (input): input is ExampleData =>
    typeof input === "object" &&
    input !== null &&
    "title" in input &&
    typeof input.title === "string" &&
    "promptText" in input &&
    typeof input.promptText === "string" &&
    "attachmentCount" in input &&
    typeof input.attachmentCount === "number",
);

function toProcedurePromptInput(input: ReturnType<typeof normalizePromptInput>): ProcedurePromptInput {
  return {
    parts: input.parts,
    text: promptInputToPlainText(input),
    displayText: promptInputDisplayText(input),
    images: promptInputAttachmentSummaries(input),
  };
}

function isTypeDescriptor<T extends KernelValue>(
  value: TypeDescriptor<T> | CommandCallAgentOptions | undefined,
): value is TypeDescriptor<T> {
  return typeof value === "object" && value !== null && "validate" in value;
}

test("procedure-sdk supports a consumer-style author workflow against the public sdk surface", async () => {
  const seededPrompt = normalizePromptInput({
    parts: [
      ...createTextPromptInput("Summarize the release notes for ").parts,
      {
        type: "image",
        token: "[Image 1: PNG 1200x800 28KB]",
        mimeType: "image/png",
        data: "ZmFrZS1pbWFnZQ==",
        width: 1200,
        height: 800,
        byteLength: 28_000,
      },
      {
        type: "text",
        text: " before publishing.",
      },
    ],
  });
  const procedurePromptInput = toProcedurePromptInput(seededPrompt);

  const procedure: Procedure = {
    name: "release-summary",
    description: "Summarize release notes into a typed payload.",
    inputHint: "Provide screenshots when the release changes UI behavior.",
    async execute(prompt: string, ctx: ProcedureApi): Promise<ProcedureResult<ExampleData>> {
      const promptInput = normalizePromptInput(
        ctx.promptInput ? { parts: ctx.promptInput.parts } : createTextPromptInput(prompt),
      );
      const displayText = promptInputDisplayText(promptInput);
      const plainText = promptInputToPlainText(promptInput);
      const attachments = promptInputAttachmentSummaries(promptInput);
      const agentResult = await ctx.agent.run(displayText, ExampleDataType, {
        promptInput,
      });
      const data = expectData(agentResult);
      const dataRef = expectDataRef(agentResult);

      return {
        data: {
          ...data,
          promptText: plainText,
          attachmentCount: attachments.length,
        },
        display: dataRef.path,
        explicitDataSchema: ExampleDataType.schema,
        summary: displayText,
      };
    },
  };

  const agentResult = {
    run: {
      sessionId: "session-release",
      runId: "run-release",
    },
    data: {
      title: "April release",
      promptText: "placeholder",
      attachmentCount: 999,
    },
    dataRef: {
      run: {
        sessionId: "session-release",
        runId: "run-release",
      },
      path: "output.data",
    },
  } satisfies RunResult<ExampleData>;

  const textAgentResult = {
    ...agentResult,
    data: procedurePromptInput.displayText,
  } satisfies RunResult<string>;

  async function run(prompt: string, options?: CommandCallAgentOptions): Promise<RunResult<string>>;
  async function run<T extends KernelValue>(
    prompt: string,
    descriptor: TypeDescriptor<T>,
    options?: CommandCallAgentOptions,
  ): Promise<RunResult<T>>;
  async function run<T extends KernelValue>(
    prompt: string,
    descriptorOrOptions?: TypeDescriptor<T> | CommandCallAgentOptions,
    options?: CommandCallAgentOptions,
  ): Promise<RunResult<string> | RunResult<T>> {
    expect(prompt).toBe(procedurePromptInput.displayText);

    if (isTypeDescriptor(descriptorOrOptions)) {
      expect(options?.promptInput).toEqual(seededPrompt);
      expect(descriptorOrOptions.validate(agentResult.data)).toBe(true);
      return {
        ...agentResult,
        data: agentResult.data as T,
      };
    }

    expect(descriptorOrOptions?.promptInput).toEqual(seededPrompt);
    return textAgentResult;
  }

  const agent: AgentInvocationApi = {
    run,
    session() {
      throw new Error("Not used in this author workflow test");
    },
  };

  const executed = await procedure.execute(
    "ignored by prompt input",
    {
      cwd: "/workspace",
      sessionId: "session-release",
      promptInput: procedurePromptInput,
      agent,
      state: {} as ProcedureApi["state"],
      ui: {} as ProcedureApi["ui"],
      procedures: {} as ProcedureApi["procedures"],
      session: {} as ProcedureApi["session"],
      assertNotCancelled() {},
    } as ProcedureApi,
  );

  expect(ExampleDataType.validate({
    title: "ok",
    promptText: "text",
    attachmentCount: 1,
  })).toBe(true);
  expect(ExampleDataType.validate({
    title: "bad",
    promptText: 1,
    attachmentCount: 1,
  })).toBe(false);
  expect(procedure.name).toBe("release-summary");
  expect(executed).toEqual({
    data: {
      title: "April release",
      promptText: "Summarize the release notes for  before publishing.",
      attachmentCount: 1,
    },
    display: "output.data",
    explicitDataSchema: ExampleDataType.schema,
    summary: "Summarize the release notes for [Image 1: PNG 1200x800 28KB] before publishing.",
  });
});
