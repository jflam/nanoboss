import { expect, test } from "bun:test";

import type { Ref } from "@nanoboss/contracts";
import { ProcedureRegistry } from "@nanoboss/procedure-catalog";
import { CommandContextImpl, RunLogger } from "@nanoboss/procedure-engine";
import { SessionStore } from "@nanoboss/store";
import { describeE2E } from "./helpers.ts";

interface SecondOpinionData {
  subject: string;
  answer: Ref;
  critique: Ref;
  verdict: "sound" | "mixed" | "flawed";
}

describeE2E("/second-opinion (real agents)", () => {
  test(
    "returns a critique manifest and rendered display",
    async () => {
      const registry = new ProcedureRegistry();
      await registry.loadFromDisk();

      const procedure = registry.get("second-opinion");
      if (!procedure) {
        throw new Error("Missing /second-opinion procedure");
      }

      const output: string[] = [];
      const logger = new RunLogger();
      const store = new SessionStore({
        sessionId: crypto.randomUUID(),
        cwd: process.cwd(),
      });
      const ctx = new CommandContextImpl({
        cwd: process.cwd(),
        logger,
        registry,
        procedureName: "second-opinion",
        spanId: logger.newSpan(),
        emitter: {
          emit(update) {
            if (
              update.sessionUpdate === "agent_message_chunk" &&
              update.content.type === "text"
            ) {
              output.push(update.content.text);
            }
          },
          async flush() {},
        },
        store,
        run: store.startRun({
          procedure: "second-opinion",
          input: "What is 2 + 2? Reply with just the number.",
          kind: "top_level",
        }),
      });

      const result = await procedure.execute(
        "What is 2 + 2? Reply with just the number.",
        ctx,
      );

      expect(typeof result).toBe("object");
      if (!result || typeof result === "string") {
        throw new Error("Expected ProcedureResult object");
      }

      expect(result.summary).toContain("second-opinion:");
      expect(result.display).toContain("First answer (");
      expect(result.display).toContain("Codex critique (gpt-5.4/high)");
      expect(result.display).toContain("Revised answer");

      const transcript = output.join("");
      expect(transcript).toContain("Starting second-opinion workflow...");
      expect(transcript).toContain("Asking the current default model (");
      expect(transcript).toContain("Asking Codex to critique the answer...");
      expect(transcript).toContain("Completed second-opinion workflow with verdict:");

      const data = result.data as SecondOpinionData | undefined;
      expect(data?.subject).toBe("What is 2 + 2? Reply with just the number.");
      expect(data?.verdict).toMatch(/sound|mixed|flawed/);
      expect(data?.answer).toBeDefined();
      expect(data?.critique).toBeDefined();
    },
    180_000,
  );
});
