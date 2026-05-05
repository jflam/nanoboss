import { readFileSync } from "node:fs";
import { join } from "node:path";

import typia from "typia";

import { detectRepoRoot } from "@nanoboss/app-support";
import { normalizeProcedureName, type LoadableProcedureRegistry } from "@nanoboss/procedure-catalog";
import { expectData, formatErrorMessage, jsonType } from "@nanoboss/procedure-sdk";
import type {
  Procedure,
  ProcedureApi,
  ProcedureMetadata,
} from "@nanoboss/procedure-sdk";

interface GeneratedProcedure {
  name: string;
  source: string;
}

export const CREATE_PROCEDURE_METADATA = {
  name: "create",
  description: "Create a new procedure from natural language",
  inputHint: "Describe the procedure you want to create",
} satisfies ProcedureMetadata;

const GeneratedProcedureType = jsonType<GeneratedProcedure>(
  typia.json.schema<GeneratedProcedure>(),
  typia.createValidate<GeneratedProcedure>(),
);

export function createCreateProcedure(registry: LoadableProcedureRegistry): Procedure {
  return {
    ...CREATE_PROCEDURE_METADATA,
    async execute(prompt, ctx) {
      const examples = loadExamples(ctx.cwd);
      const generated = await ctx.agent.run(
        [
          "You are generating a nanoboss procedure.",
          "Return exactly one JSON object matching the requested schema.",
          "Do not include markdown fences, explanations, or prose outside the JSON object.",
          "",
          "A procedure is a TypeScript module that exports a default object with:",
          '- `name: string`',
          '- `description: string`',
          "- `execute(prompt: string, ctx: ProcedureApi): Promise<ProcedureResult>`",
          "- optional `resume(prompt: string, state: KernelValue, ctx: ProcedureApi): Promise<ProcedureResult>` when the procedure needs to pause and continue later",
          "",
          "The procedure API provides:",
          "- `ctx.agent.run(prompt)` for untyped downstream calls returning RunResult<string> from a fresh isolated ACP session",
          "- `ctx.agent.run(prompt, descriptor)` for typed downstream calls returning RunResult<T> from a fresh isolated ACP session",
          "- `ctx.agent.run(prompt, { session: \"default\" })` to continue the current nanoboss session's default agent session",
          "- `ctx.agent.run(prompt, descriptor, { session: \"default\" })` when you need typed JSON output while continuing the current conversation",
          "- `ctx.agent.run(prompt, { agent: { provider, model }, refs, session })` to choose a downstream agent, pass named refs, and explicitly select fresh vs default session behavior",
          "- `ctx.procedures.run(name, prompt)` for composing procedures and getting RunResult<T> while inheriting the current agent-session binding",
          "- `ctx.procedures.run(name, prompt, { session: \"default\" | \"fresh\" | \"inherit\" })` to control whether the child procedure uses the master agent session, a private one, or the current inherited binding",
          "- `ctx.state.runs.list(...)` for top-level run discovery and `ctx.state.runs.list({ scope: \"recent\" })` only for true global recency scans across the whole session",
          "- `ctx.state.runs.getDescendants(...)`, `ctx.state.runs.getAncestors(...)`, and `ctx.state.runs.get(...)` for structural traversal over prior runs",
          "- `ctx.state.refs.read(...)` and `ctx.state.refs.writeToFile(...)` for durable references",
          "- `ctx.ui.text(text)` to stream progress back to the CLI and `ctx.ui.info|warning|error|status|card` for structured procedure output",
          "- `ctx.session.getDefaultAgentConfig()` and `ctx.session.setDefaultAgentSelection(...)` to inspect or change the session's default downstream agent",
          "- `ctx.session.getDefaultAgentTokenUsage()` when a procedure needs the latest live default agent-session token metrics",
          "- `ctx.assertNotCancelled()` to cooperatively stop long-running work at safe checkpoints",
          `- \`ctx.cwd\` for the current working directory (${ctx.cwd})`,
          "",
          "For typed agent outputs:",
          '- import `typia` from `typia` and `jsonType` from "@nanoboss/procedure-sdk"`',
          "- define descriptors as `const ResultType = jsonType<Result>(typia.json.schema<Result>(), typia.createValidate<Result>())`",
          "- do not hand-write JSON schema or `validate()` boilerplate when the `typia` + `jsonType(...)` pattern can express the shape",
          "",
          "For reading structured procedure results:",
          '- import `expectData` and `expectDataRef` from "@nanoboss/procedure-sdk"`',
          "",
          "Session-selection guidance:",
          "- prefer the default fresh mode for isolated sub-tasks, validation passes, and deterministic structured work",
          "- use `session: \"default\"` only when conversational continuity with the current thread is the point",
          "- when you need typed JSON while reusing conversation state, use typed `ctx.agent.run(...)` instead of ad hoc parsing",
          "",
          "ProcedureResult should usually:",
          "- keep `data` small and ref-heavy",
          "- put user-facing output in `display`",
          "- put a short discovery string in `summary`",
          "- set `pause: { question, state, inputHint?, suggestedReplies? }` when the procedure should ask the user an open-ended follow-up and resume on the next plain-text reply",
          "",
          "Generated procedures are persisted at `.nanoboss/procedures/<name>.ts` for unscoped names and `.nanoboss/procedures/<package>/<leaf>.ts` for scoped names.",
          'Import procedure authoring helpers from `@nanoboss/procedure-sdk`. Do not import from root `src/` paths.',
          "",
          "Use existing built-in procedures as style references:",
          examples,
          "",
          `User request: ${prompt}`,
          "",
          "Return the procedure name and full TypeScript source.",
        ].join("\n"),
        GeneratedProcedureType,
        { stream: false },
      );
      const generatedData: GeneratedProcedure = expectData(
        generated,
        "Procedure generation returned no data",
      );

      const procedureName = sanitizeProcedureName(generatedData.name);
      const source = normalizeGeneratedProcedureSource(generatedData.source, procedureName);

      const filePath = await registry.persist(procedureName, source, ctx.cwd);

      const procedure = await registry.loadProcedureFromPath(filePath);
      registry.register(procedure);

      return {
        data: {
          procedure: procedure.name,
          filePath,
        },
        display: `Created and loaded procedure /${procedure.name} at ${filePath}`,
        summary: `create: /${procedure.name}`,
      };
    },
  };
}

const defaultProcedure = {
  ...CREATE_PROCEDURE_METADATA,
  async execute(_prompt: string, _ctx: ProcedureApi) {
    throw new Error("The /create procedure must be bound to a registry before execution.");
  },
} satisfies Procedure;

export default defaultProcedure;

function loadExamples(cwd: string): string {
  const examplesRoot = detectRepoRoot(cwd) ?? cwd;
  const examples = ["research.ts", "kb/refresh.ts"]
    .map((file) => {
      try {
        return `// ${file}\n${readFileSync(join(examplesRoot, "procedures", file), "utf8")}`;
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
  } catch (error) {
    throw new Error(`Generated procedure name was invalid: ${formatErrorMessage(error)}`, {
      cause: error,
    });
  }
}

function normalizeGeneratedProcedureSource(source: string, procedureName: string): string {
  return source
    .replace(/name:\s*["'`][^"'`]+["'`]/, `name: "${procedureName}"`)
    .replace(/(["'`])@nanoboss\/contracts\1/g, "$1@nanoboss/procedure-sdk$1")
    .replace(/(["'`])(?:\.\.?\/)+src\/core\/(?:types|run-result)\.ts\1/g, "$1@nanoboss/procedure-sdk$1");
}
