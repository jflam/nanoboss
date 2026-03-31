import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  type KernelValue,
  type Procedure,
  type ProcedureRegistryLike,
  type RunResult,
  type TypeDescriptor,
} from "./types.ts";

interface GeneratedProcedure {
  name: string;
  source: string;
}

const GeneratedProcedureType: TypeDescriptor<GeneratedProcedure> = {
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
      const generated = await ctx.callAgent(
        [
          "You are generating a nano-agentboss procedure.",
          "",
          "A procedure is a TypeScript module that exports a default object with:",
          '- `name: string`',
          '- `description: string`',
          "- `execute(prompt: string, ctx: CommandContext): Promise<ProcedureResult>`",
          "",
          "CommandContext provides:",
          "- `ctx.callAgent(prompt)` for untyped downstream calls returning RunResult<string>",
          "- `ctx.callAgent(prompt, descriptor)` for typed downstream calls returning RunResult<T>",
          "- `ctx.callAgent(prompt, { agent: { provider, model }, refs })` to choose a downstream agent per call and pass prior refs",
          "- `ctx.callProcedure(name, prompt)` for composing procedures and getting RunResult<T>",
          "- `ctx.session.last()` and `ctx.session.recent(...)` for discovery over prior cells",
          "- `ctx.refs.read(...)` and `ctx.refs.writeToFile(...)` for durable references",
          "- `ctx.print(text)` to stream progress back to the CLI",
          `- \`ctx.cwd\` for the current working directory (${ctx.cwd})`,
          "",
          "ProcedureResult should usually:",
          "- keep `data` small and ref-heavy",
          "- put user-facing output in `display`",
          "- put a short discovery string in `summary`",
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
      const generatedData: GeneratedProcedure = requireData(
        generated,
        "Procedure generation returned no data",
      );

      const procedureName = sanitizeProcedureName(generatedData.name);
      const source = generatedData.source.replace(
        /name:\s*["'`][^"'`]+["'`]/,
        `name: "${procedureName}"`,
      );

      const filePath = await registry.persist(
        {
          name: procedureName,
          description: "Generated procedure placeholder",
          async execute() {
            return {};
          },
        },
        source,
      );

      const procedure = await registry.loadProcedureFromPath(filePath);
      registry.register(procedure);

      return {
        data: {
          procedure: procedure.name,
          filePath,
        },
        display: `Created procedure /${procedure.name} at ${filePath}`,
        summary: `create: /${procedure.name}`,
      };
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

function requireData<T extends KernelValue>(result: RunResult<T>, message: string): T {
  if (result.data === undefined) {
    throw new Error(message);
  }

  return result.data;
}
