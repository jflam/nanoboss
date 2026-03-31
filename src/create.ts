import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Procedure, ProcedureRegistryLike } from "./types.ts";

interface GeneratedProcedure {
  name: string;
  source: string;
}

const GeneratedProcedureType = {
  schema: {
    type: "object",
    properties: {
      name: { type: "string" },
      source: { type: "string" },
    },
    required: ["name", "source"],
    additionalProperties: false,
  },
  validate(input: unknown): input is GeneratedProcedure {
    return (
      typeof input === "object" &&
      input !== null &&
      "name" in input &&
      typeof (input as { name: unknown }).name === "string" &&
      "source" in input &&
      typeof (input as { source: unknown }).source === "string"
    );
  },
};

export function createCreateProcedure(registry: ProcedureRegistryLike): Procedure {
  return {
    name: "create",
    description: "Create a new procedure from natural language",
    inputHint: "Describe the procedure you want to create",
    async execute(prompt, ctx) {
      const examples = loadExamples();
      const generated = await ctx.callAgent<GeneratedProcedure>(
        [
          "You are generating a nano-agentboss procedure.",
          "",
          "A procedure is a TypeScript module that exports a default object with:",
          '- `name: string`',
          '- `description: string`',
          "- `execute(prompt: string, ctx: CommandContext): Promise<string | void>`",
          "",
          "CommandContext provides:",
          "- `ctx.callAgent(prompt)` for untyped downstream calls",
          "- `ctx.callAgent<T>(prompt, descriptor)` for typed downstream calls",
          "- `ctx.callAgent(prompt, undefined, { agent: { provider, model } })` to choose a downstream agent per call",
          "- `ctx.callProcedure(name, prompt)` for composing procedures",
          "- `ctx.print(text)` to stream output back to the CLI",
          `- \`ctx.cwd\` for the current working directory (${ctx.cwd})`,
          "",
          "Use existing commands as style references:",
          examples,
          "",
          `User request: ${prompt}`,
          "",
          "Return the procedure name and full TypeScript source.",
        ].join("\n"),
        GeneratedProcedureType,
      );

      const procedureName = sanitizeProcedureName(generated.value.name);
      const source = generated.value.source.replace(
        /name:\s*["'`][^"'`]+["'`]/,
        `name: "${procedureName}"`,
      );

      const filePath = await registry.persist(
        {
          name: procedureName,
          description: "Generated procedure placeholder",
          async execute() {},
        },
        source,
      );

      const procedure = await registry.loadProcedureFromPath(filePath);
      registry.register(procedure);

      ctx.print(`Created procedure /${procedure.name} at ${filePath}`);
    },
  };
}

function loadExamples(): string {
  const cwd = process.cwd();
  const examples = ["commit.ts", "linter.ts"]
    .map((file) => {
      try {
        return `// ${file}\n${readFileSync(join(cwd, "commands", file), "utf8")}`;
      } catch {
        return "";
      }
    })
    .filter(Boolean);

  return examples.join("\n\n");
}

function sanitizeProcedureName(value: string): string {
  const trimmed = value.trim().replace(/^\/+/, "");
  const sanitized = trimmed
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();

  if (!sanitized) {
    throw new Error("Generated procedure name was empty");
  }

  return sanitized;
}
