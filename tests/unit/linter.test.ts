import { describe, expect, test } from "bun:test";

import { buildFixPrompt, groupErrorsByFile } from "../../commands/linter.ts";

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
});
