import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RunLogger } from "@nanoboss/procedure-engine";

describe("RunLogger", () => {
  test("writes JSONL to the configured file path", () => {
    const logger = new RunLogger(
      "00000000-0000-4000-8000-000000000001",
      mkdtempSync(join(tmpdir(), "nab-logs-")),
    );

    logger.write({
      spanId: "span-1",
      procedure: "default",
      kind: "procedure_start",
    });

    const content = readFileSync(logger.filePath, "utf8");
    expect(content).toContain('"runId":"00000000-0000-4000-8000-000000000001"');
    expect(content).toContain('"procedure":"default"');
  });

  test("assigns unique span IDs", () => {
    const logger = new RunLogger(
      "00000000-0000-4000-8000-000000000002",
      mkdtempSync(join(tmpdir(), "nab-logs-")),
    );
    expect(logger.newSpan()).not.toBe(logger.newSpan());
  });

  test("captures parentSpanId links", () => {
    const logger = new RunLogger(
      "00000000-0000-4000-8000-000000000003",
      mkdtempSync(join(tmpdir(), "nab-logs-")),
    );
    const parent = logger.newSpan();
    const child = logger.newSpan(parent);

    logger.write({
      spanId: child,
      parentSpanId: parent,
      procedure: "child",
      kind: "procedure_start",
    });

    const lines = readFileSync(logger.filePath, "utf8").trim().split("\n");
    expect(lines[0]).toContain(`"parentSpanId":"${parent}"`);
  });

  test("procedure start and end pairs are written", () => {
    const logger = new RunLogger(
      "00000000-0000-4000-8000-000000000004",
      mkdtempSync(join(tmpdir(), "nab-logs-")),
    );
    const spanId = logger.newSpan();

    logger.write({ spanId, procedure: "linter", kind: "procedure_start" });
    logger.write({ spanId, procedure: "linter", kind: "procedure_end", durationMs: 12 });

    const content = readFileSync(logger.filePath, "utf8");
    expect(content.match(/procedure_start/g)?.length).toBe(1);
    expect(content.match(/procedure_end/g)?.length).toBe(1);
  });

  test("agent timing is logged", () => {
    const logger = new RunLogger(
      "00000000-0000-4000-8000-000000000005",
      mkdtempSync(join(tmpdir(), "nab-logs-")),
    );
    const spanId = logger.newSpan();

    logger.write({
      spanId,
      procedure: "default",
      kind: "agent_end",
      durationMs: 42,
    });

    const content = readFileSync(logger.filePath, "utf8");
    expect(content).toContain('"durationMs":42');
  });
});
