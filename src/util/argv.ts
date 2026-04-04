export function requireValue(value: string | undefined, flag: string): string {
  if (!value) {
    throw new Error(`Missing value for ${flag}`);
  }

  return value;
}
