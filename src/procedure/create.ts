import { readFileSync } from "node:fs";
import { join } from "node:path";

import typia from "typia";

import { expectData } from "../core/run-result.ts";
import { jsonType } from "../core/types.ts";
import { normalizeProcedureName, resolveProcedureImportPrefix } from "./names.ts";
import type {
  Procedure,
  ProcedureRegistryLike,
} from "../core/types.ts";

interface GeneratedProcedure {
  name: string;
  source: string;
}

const GeneratedProcedureType = jsonType<GeneratedProcedure>(
  typia.json.schema<GeneratedProcedure>(),
  typia.createValidate<GeneratedProcedure>(),
);

export function createCreateProcedure(registry: ProcedureRegistryLike): Procedure {
  return {
    name: "create",
    description: "Create a new procedure from natural language",
    inputHint: "Describe the procedure you want to create",
    async execute(prompt, ctx) {
      const examples = loadExamples();
      const generated = await ctx.callAgent(
        [
          "You are generating a nanoboss procedure.",
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
          "- `ctx.getDefaultAgentConfig()` and `ctx.setDefaultAgentSelection(...)` to inspect or change the session's default downstream agent",
          "- `ctx.assertNotCancelled()` to cooperatively stop long-running work at safe checkpoints",
          "- `ctx.session.topLevelRuns(...)`, `ctx.session.descendants(...)`, `ctx.session.ancestors(...)`, and `ctx.session.get(...)` for structural discovery over prior cells",
          "- `ctx.session.recent(...)` only for true global recency scans across the whole session",
          "- `ctx.refs.read(...)` and `ctx.refs.writeToFile(...)` for durable references",
          "- `ctx.print(text)` to stream progress back to the CLI",
          `- \`ctx.cwd\` for the current working directory (${ctx.cwd})`,
          "",
          "For typed agent outputs:",
           "- import `typia` from `typia` and `jsonType` from `../../src/core/types.ts`",
          "- define descriptors as `const ResultType = jsonType<Result>(typia.json.schema<Result>(), typia.createValidate<Result>())`",
          "- do not hand-write JSON schema or `validate()` boilerplate when the `typia` + `jsonType(...)` pattern can express the shape",
          "",
          "ProcedureResult should usually:",
          "- keep `data` small and ref-heavy",
          "- put user-facing output in `display`",
          "- put a short discovery string in `summary`",
          "",
           "Generated procedures are persisted at `procedures/<name>.ts` for unscoped names and `procedures/<package>/<leaf>.ts` for scoped names.",
           "When you need nanoboss runtime imports from src/, use a relative path from that persisted file location, for example `../src/core/types.ts` for `/review` and `../../src/core/types.ts` for `/kb/answer`.",
           "",
           "Use existing built-in procedures as style references:",
          examples,
          "",
          `User request: ${prompt}`,
          "",
          "Return the procedure name and full TypeScript source.",
        ].join("\n"),
        GeneratedProcedureType,
      );
      const generatedData: GeneratedProcedure = expectData(
        generated,
        "Procedure generation returned no data",
      );

      const procedureName = sanitizeProcedureName(generatedData.name);
      const source = normalizeGeneratedProcedureSource(generatedData.source, procedureName);

      const filePath = await registry.persist(
        {
          name: procedureName,
          description: "Generated procedure placeholder",
          async execute() {
            return {};
          },
        },
        source,
        ctx.cwd,
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
        return `// ${file}\n${readFileSync(join(cwd, "procedures", file), "utf8")}`;
      } catch {
        return "";
      }
    })
    .filter(Boolean);

  return examples.join("\n\n");
}

function sanitizeProcedureName(value: string): string {
  try {
    return normalizeProcedureName(value);
  } catch {
    throw new Error("Generated procedure name was empty");
  }
}

function normalizeGeneratedProcedureSource(source: string, procedureName: string): string {
  const importPrefix = resolveProcedureImportPrefix(procedureName);
  return source
    .replace(/name:\s*["'`][^"'`]+["'`]/, `name: "${procedureName}"`)
    .replace(/(["'`])(?:\.\.\/)+src\//g, `$1${importPrefix}src/`);
}
