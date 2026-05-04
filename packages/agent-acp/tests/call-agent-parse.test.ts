import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { invokeAgent, type CallAgentTransport } from "@nanoboss/agent-acp";
import { jsonType } from "@nanoboss/procedure-sdk";

interface MathResult {
  result: number;
}

const originalHome = process.env.HOME;
const testHome = mkdtempSync(join(tmpdir(), "nanoboss-call-agent-parse-home-"));

process.env.HOME = testHome;
process.on("exit", () => {
  try {
    rmSync(testHome, { recursive: true, force: true });
  } catch {
    // Ignore cleanup failures during test shutdown.
  }

  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
});

const MathResultType = jsonType<MathResult>(
  {
    type: "object",
    properties: {
      result: { type: "number" },
    },
    required: ["result"],
    additionalProperties: false,
  },
  (input: unknown): input is MathResult => {
    return (
      typeof input === "object" &&
      input !== null &&
      typeof (input as { result?: unknown }).result === "number" &&
      Object.keys(input as Record<string, unknown>).length === 1
    );
  },
);

describe("invokeAgent response parsing", () => {
  test("returns raw string when no descriptor provided", async () => {
    const transport = createTransport(["plain text"]);
    const result = await invokeAgent("hello", undefined, {}, transport);

    expect(result.data).toBe("plain text");
    expect(result.raw).toBe("plain text");
  });

  test("parses valid JSON matching schema", async () => {
    const transport = createTransport(["{\"result\":4}"]);
    const result = await invokeAgent("compute", MathResultType, {}, transport);

    expect(result.data).toEqual({ result: 4 });
  });

  test("extracts typed JSON from mixed prose and trailing text", async () => {
    const transport = createTransport([
      "Running lint now, then I will report back.{\"result\":4}\nDone validating.",
    ]);
    const result = await invokeAgent("compute", MathResultType, {}, transport);

    expect(result.data).toEqual({ result: 4 });
  });

  test("rejects JSON that fails schema validation", async () => {
    const transport = createTransport(["{\"result\":\"nope\"}", "{\"result\":\"still nope\"}", "{\"result\":\"bad\"}"]);

    await expect(invokeAgent("compute", MathResultType, {}, transport)).rejects.toThrow(
      "invokeAgent failed after 3 attempts: JSON parsed but failed schema validation",
    );
  });

  test("retries on invalid JSON with error feedback", async () => {
    const transport = createTransport(["no json", "{\"result\":4}"]);
    const result = await invokeAgent("compute", MathResultType, {}, transport);

    expect(result.data).toEqual({ result: 4 });
    expect(transport.invocations).toHaveLength(2);
    expect(transport.invocations[1]).toContain("Your previous response was invalid");
  });

  test("accepts mixed prose and final JSON without retrying", async () => {
    const transport = createTransport([
      "Running the required lint command now.{\"result\":4}",
    ]);
    const result = await invokeAgent("compute", MathResultType, {}, transport);

    expect(result.data).toEqual({ result: 4 });
    expect(transport.invocations).toHaveLength(1);
  });

  test("includes named refs in the constructed prompt", async () => {
    const transport = createTransport(["plain text"]);
    await invokeAgent(
      "Summarize `answer`.",
      undefined,
      { namedRefs: { answer: { text: "hello" } } },
      transport,
    );

    const prompt = transport.invocations[0] ?? "";
    expect(prompt).toContain("<ref name=\"answer\">");
    expect(prompt).toContain("\"text\": \"hello\"");
  });

  test("throws after retries are exhausted", async () => {
    const transport = createTransport(["still bad", "still bad", "still bad"]);

    await expect(invokeAgent("compute", MathResultType, {}, transport)).rejects.toThrow(
      "invokeAgent failed after 3 attempts",
    );
  });

  test("strips markdown code fences from response before parsing", async () => {
    const transport = createTransport(["```json\n{\"result\":4}\n```"]);
    const result = await invokeAgent("compute", MathResultType, {}, transport);

    expect(result.data).toEqual({ result: 4 });
  });
});

function createTransport(responses: string[]): CallAgentTransport & { invocations: string[] } {
  const invocations: string[] = [];

  return {
    invocations,
    async invoke(prompt) {
      invocations.push(prompt);
      const raw = responses.shift() ?? "";
      return {
        raw,
        updates: [],
      };
    },
  };
}
