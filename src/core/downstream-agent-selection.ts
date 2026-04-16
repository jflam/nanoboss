import type { DownstreamAgentProvider, DownstreamAgentSelection } from "@nanoboss/contracts";

const DOWNSTREAM_AGENT_PROVIDERS: DownstreamAgentProvider[] = ["claude", "gemini", "codex", "copilot"];

export function parseDownstreamAgentSelection(value: unknown): DownstreamAgentSelection | undefined {
  const record = asRecord(value);
  const provider = asProvider(record?.provider);
  if (!provider) {
    return undefined;
  }

  const model = asOptionalNonEmptyString(record?.model);
  return model === undefined ? { provider } : { provider, model };
}

export function parseRequiredDownstreamAgentSelection(
  value: unknown,
  fieldName = "defaultAgentSelection",
): DownstreamAgentSelection {
  const record = asStrictRecord(value, fieldName);
  const provider = asRequiredProvider(record.provider, `${fieldName}.provider`);
  const model = record.model === undefined ? undefined : asRequiredString(record.model, `${fieldName}.model`);
  return model === undefined ? { provider } : { provider, model };
}

function asProvider(value: unknown): DownstreamAgentProvider | undefined {
  return typeof value === "string" && DOWNSTREAM_AGENT_PROVIDERS.includes(value as DownstreamAgentProvider)
    ? value as DownstreamAgentProvider
    : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asStrictRecord(value: unknown, name: string): Record<string, unknown> {
  const record = asRecord(value);
  if (!record) {
    throw new Error(`Expected ${name} to be an object`);
  }

  return record;
}

function asOptionalNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function asRequiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Expected ${name} to be a non-empty string`);
  }

  return value;
}

function asRequiredProvider(value: unknown, name: string): DownstreamAgentProvider {
  const provider = asRequiredString(value, name);
  if (!DOWNSTREAM_AGENT_PROVIDERS.includes(provider as DownstreamAgentProvider)) {
    throw new Error(`Expected ${name} to be one of ${DOWNSTREAM_AGENT_PROVIDERS.join(", ")}`);
  }

  return provider as DownstreamAgentProvider;
}
