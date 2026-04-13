import { execFile } from "node:child_process";

export async function readJsonFromCommand(
  command: string,
  args: string[],
  env?: Record<string, string>,
): Promise<Record<string, unknown> | undefined> {
  try {
    const stdout = await execFileText(command, args, env);
    const parsed = JSON.parse(stdout) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

export async function execFileText(
  command: string,
  args: string[],
  env?: Record<string, string>,
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    execFile(command, args, {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      env: env ? { ...process.env, ...env } : process.env,
    }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(stdout.trim());
    });
  });
}

export function parseClipboardImageRecord(value: Record<string, unknown> | undefined): {
  mimeType: string;
  data: string;
  width?: number;
  height?: number;
  byteLength?: number;
} | undefined {
  if (!value) {
    return undefined;
  }

  const mimeType = typeof value?.mimeType === "string" ? value.mimeType : undefined;
  const data = typeof value?.data === "string" ? value.data : undefined;
  if (!mimeType || !data) {
    return undefined;
  }

  return {
    mimeType,
    data,
    width: asOptionalNumber(value.width),
    height: asOptionalNumber(value.height),
    byteLength: asOptionalNumber(value.byteLength),
  };
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
