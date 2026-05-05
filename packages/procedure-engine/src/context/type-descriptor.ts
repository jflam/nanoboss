import type { TypeDescriptor } from "@nanoboss/procedure-sdk";

export function isTypeDescriptor<T>(value: unknown): value is TypeDescriptor<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    "schema" in value &&
    "validate" in value &&
    typeof (value as { validate: unknown }).validate === "function"
  );
}
