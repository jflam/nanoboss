import { describe, expect, test } from "bun:test";

import {
  buildFixPrompt,
  diffLintErrors,
  groupErrorsByFile,
  parseLintOutput,
  parseEslintJsonOutput,
  runPlannedLinter,
  selectFixWave,
} from "../../packages/linter.ts";

describe("/linter helpers", () => {
  test("groups relative and absolute paths by normalized file", () => {
    const cwd = "/repo";
    const errors = [
      {
        file: "src/app.ts",
        line: 1,
        column: 1,
        message: "first",
        rule: "rule-a",
      },
      {
        file: "/repo/src/app.ts",
        line: 2,
        column: 3,
        message: "second",
        rule: "rule-b",
      },
      {
        file: "src/other.ts",
        line: 4,
        column: 5,
        message: "third",
        rule: "rule-c",
      },
    ];

    const groups = groupErrorsByFile(cwd, errors);

    expect(groups).toHaveLength(2);
    expect(groups[0]?.normalizedFile).toBe("/repo/src/app.ts");
    expect(groups[0]?.displayFile).toBe("src/app.ts");
    expect(groups[0]?.errors).toHaveLength(2);
    expect(groups[1]?.normalizedFile).toBe("/repo/src/other.ts");
  });

  test("builds a file-scoped prompt that forbids full lint", () => {
    const prompt = buildFixPrompt({
      normalizedFile: "/repo/src/app.ts",
      displayFile: "src/app.ts",
      errors: [
        {
          file: "src/app.ts",
          line: 10,
          column: 2,
          message: "problem",
          rule: "rule-a",
        },
      ],
    });

    expect(prompt).toContain("Fix only the following linter errors in /repo/src/app.ts:");
    expect(prompt).toContain("- src/app.ts:10:2 problem (rule: rule-a)");
    expect(prompt).toContain("Do not run the full repo linter");
    expect(prompt).toContain("Do not search for or fix unrelated lint errors in other files.");
    expect(prompt).toContain("The caller will rerun lint and manage commits after you return.");
  });

  test("parses eslint json output into normalized linter errors", () => {
    const errors = parseEslintJsonOutput(
      "/repo",
      JSON.stringify([
        {
          filePath: "src/app.ts",
          messages: [
            {
              line: 4,
              column: 2,
              message: "problem",
              ruleId: "@typescript-eslint/no-unused-vars",
              severity: 2,
            },
            {
              line: 5,
              column: 1,
              message: "warning",
              ruleId: "no-console",
              severity: 1,
            },
          ],
        },
        {
          filePath: "/repo/src/other.ts",
          messages: [
            {
              line: 1,
              column: 1,
              message: "parse error",
              ruleId: null,
              severity: 2,
            },
          ],
        },
      ]),
    );

    expect(errors).toEqual([
      {
        file: "/repo/src/app.ts",
        line: 4,
        column: 2,
        message: "problem",
        rule: "@typescript-eslint/no-unused-vars",
      },
      {
        file: "/repo/src/other.ts",
        line: 1,
        column: 1,
        message: "parse error",
        rule: "parsing",
      },
    ]);
  });

  test("parses generic diagnostic-array json output via parser config", () => {
    const errors = parseLintOutput(
      "/repo",
      JSON.stringify({
        diagnostics: [
          {
            path: "src/app.ts",
            row: "7",
            col: 3,
            text: "problem",
            code: "custom/rule",
            level: "error",
          },
          {
            path: "src/app.ts",
            row: 8,
            col: 1,
            text: "warning",
            code: "custom/warn",
            level: "warning",
          },
        ],
      }),
      {
        kind: "diagnostic-array-json",
        entriesPath: ["diagnostics"],
        fileField: "path",
        lineField: "row",
        columnField: "col",
        messageField: "text",
        ruleField: "code",
        severityField: "level",
        errorSeverities: ["error"],
      },
    );

    expect(errors).toEqual([
      {
        file: "/repo/src/app.ts",
        line: 7,
        column: 3,
        message: "problem",
        rule: "custom/rule",
      },
    ]);
  });

  test("parses generic file-message json output via parser config", () => {
    const errors = parseLintOutput(
      "/repo",
      JSON.stringify({
        files: [
          {
            filename: "/repo/src/other.ts",
            diagnostics: [
              {
                row: 1,
                col: 9,
                text: "parse error",
                level: "error",
              },
              {
                row: 2,
                col: 1,
                text: "warning",
                level: "warning",
              },
            ],
          },
        ],
      }),
      {
        kind: "file-message-array-json",
        entriesPath: ["files"],
        fileField: "filename",
        messagesField: "diagnostics",
        lineField: "row",
        columnField: "col",
        messageField: "text",
        severityField: "level",
        errorSeverities: ["error"],
        defaultRule: "generic",
      },
    );

    expect(errors).toEqual([
      {
        file: "/repo/src/other.ts",
        line: 1,
        column: 9,
        message: "parse error",
        rule: "generic",
      },
    ]);
  });

  test("runs a discovered adapter before parsing rerun output", () => {
    const cwd = process.cwd();
    const result = runPlannedLinter({
      cwd,
      executable: "bun",
      args: [
        "-e",
        "console.log('src/app.ts|4|2|problem|custom/rule'); process.exit(1);",
      ],
      adapter: {
        executable: "bun",
        args: [
          "-e",
          [
            "const input = await new Response(Bun.stdin.stream()).text();",
            "const [file, line, column, message, rule] = input.trim().split('|');",
            "console.log(JSON.stringify({ diagnostics: [{ path: file, row: Number(line), col: Number(column), text: message, code: rule, level: 'error' }] }));",
          ].join(" "),
        ],
      },
      parser: {
        kind: "diagnostic-array-json",
        entriesPath: ["diagnostics"],
        fileField: "path",
        lineField: "row",
        columnField: "col",
        messageField: "text",
        ruleField: "code",
        severityField: "level",
        errorSeverities: ["error"],
      },
    });

    expect(result.command).toContain(" | ");
    expect(result.errors).toEqual([
      {
        file: `${cwd}/src/app.ts`,
        line: 4,
        column: 2,
        message: "problem",
        rule: "custom/rule",
      },
    ]);
  });

  test("selects a bounded fix wave", () => {
    const groups = groupErrorsByFile("/repo", [
      {
        file: "src/a.ts",
        line: 1,
        column: 1,
        message: "first",
        rule: "rule-a",
      },
      {
        file: "src/b.ts",
        line: 1,
        column: 1,
        message: "second",
        rule: "rule-b",
      },
      {
        file: "src/c.ts",
        line: 1,
        column: 1,
        message: "third",
        rule: "rule-c",
      },
    ]);

    const wave = selectFixWave(groups, 2);

    expect(wave.map((group) => group.displayFile)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("counts resolved errors even when rerun surfaces additional errors", () => {
    const delta = diffLintErrors(
      "/repo",
      [
        {
          file: "src/target.ts",
          line: 1,
          column: 1,
          message: "first",
          rule: "rule-a",
        },
      ],
      [
        {
          file: "src/other.ts",
          line: 2,
          column: 3,
          message: "second",
          rule: "rule-b",
        },
        {
          file: "src/another.ts",
          line: 4,
          column: 5,
          message: "third",
          rule: "rule-c",
        },
      ],
    );

    expect(delta).toEqual({
      resolvedCount: 1,
      surfacedCount: 2,
    });
  });

  test("normalizes file paths when diffing lint errors", () => {
    const delta = diffLintErrors(
      "/repo",
      [
        {
          file: "src/app.ts",
          line: 7,
          column: 9,
          message: "problem",
          rule: "rule-a",
        },
      ],
      [
        {
          file: "/repo/src/app.ts",
          line: 7,
          column: 9,
          message: "problem",
          rule: "rule-a",
        },
      ],
    );

    expect(delta).toEqual({
      resolvedCount: 0,
      surfacedCount: 0,
    });
  });
});
