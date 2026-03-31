import { describe, expect, test } from "bun:test";
import typia from "typia";

import { jsonType } from "../../src/types.ts";

describe("jsonType", () => {
  interface Answer {
    answer: number;
  }

  test("builds a schema and validator from the type", () => {
    const descriptor = jsonType<Answer>(
      typia.json.schema<Answer>(),
      typia.createValidate<Answer>(),
    );

    expect(descriptor.schema).toMatchObject({
      schema: {
        $ref: "#/components/schemas/Answer",
      },
    });
    expect(descriptor.validate({ answer: 42 })).toBe(true);
    expect(descriptor.validate({ answer: "nope" })).toBe(false);
  });

  test("throws when called without transformed typia inputs", () => {
    expect(() => {
      // @ts-expect-error intentional misuse for runtime guard coverage
      jsonType<Answer>();
    }).toThrow(
      "jsonType(...) requires concrete schema and validator arguments",
    );
  });
});
