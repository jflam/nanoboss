import {
  createTextPromptInput,
  hasPromptInputContent,
  parsePromptInputPayload,
  type PromptInput,
} from "@nanoboss/procedure-sdk";

export function parseSessionPromptRequestBody(body: { prompt?: string; promptInput?: unknown }):
  | { prompt: PromptInput }
  | { error: string } {
  const promptInput = body.promptInput !== undefined
    ? parsePromptInputPayload(body.promptInput)
    : undefined;
  if (body.promptInput !== undefined && !promptInput) {
    return { error: "promptInput is invalid" };
  }
  if (promptInput) {
    return hasPromptInputContent(promptInput)
      ? { prompt: promptInput }
      : { error: "prompt is required" };
  }

  const prompt = body.prompt?.trim();
  return prompt
    ? { prompt: createTextPromptInput(prompt) }
    : { error: "prompt is required" };
}
