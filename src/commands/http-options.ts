import { requireValue } from "../util/argv.ts";
import type { HttpServerOptions } from "@nanoboss/adapters-http";

export const DEFAULT_HTTP_SERVER_PORT = 6502;
export const DEFAULT_HTTP_SERVER_URL = `http://localhost:${DEFAULT_HTTP_SERVER_PORT}`;

export function parseHttpServerOptions(argv: string[]): HttpServerOptions {
  let port = Number(Bun.env.NANOBOSS_PORT ?? String(DEFAULT_HTTP_SERVER_PORT));
  let host = normalizeHost(Bun.env.NANOBOSS_HOST);
  let mode = normalizeMode(Bun.env.NANOBOSS_HTTP_MODE) ?? "shared";
  let readySignal = false;
  const idleTimeoutSeconds = Number(Bun.env.NANOBOSS_HTTP_IDLE_TIMEOUT_SECONDS ?? "30");
  const sseKeepAliveMs = Number(Bun.env.NANOBOSS_SSE_KEEPALIVE_MS ?? "10000");

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) {
      continue;
    }

    if (arg === "--port") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error("--port requires a value");
      }
      port = Number(next);
      index += 1;
      continue;
    }

    if (arg === "--host") {
      host = normalizeHost(requireValue(argv[index + 1], "--host"));
      index += 1;
      continue;
    }

    if (arg === "--mode") {
      mode = parseMode(argv[index + 1], "--mode");
      index += 1;
      continue;
    }

    if (arg === "--ready-signal") {
      readySignal = true;
      continue;
    }

    if (arg.startsWith("--port=")) {
      port = Number(arg.slice("--port=".length));
      continue;
    }

    if (arg.startsWith("--host=")) {
      host = normalizeHost(arg.slice("--host=".length));
      continue;
    }

    if (arg.startsWith("--mode=")) {
      mode = parseMode(arg.slice("--mode=".length), "--mode");
    }
  }

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid port: ${String(port)}`);
  }

  if (!Number.isFinite(idleTimeoutSeconds) || idleTimeoutSeconds <= 0) {
    throw new Error(`Invalid idle timeout: ${String(idleTimeoutSeconds)}`);
  }

  if (!Number.isFinite(sseKeepAliveMs) || sseKeepAliveMs <= 0) {
    throw new Error(`Invalid SSE keepalive: ${String(sseKeepAliveMs)}`);
  }

  return {
    port,
    host,
    mode,
    readySignal,
    idleTimeoutSeconds,
    sseKeepAliveMs,
  };
}

function normalizeHost(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeMode(value: string | undefined): "private" | "shared" | undefined {
  return value === "private" || value === "shared" ? value : undefined;
}

function parseMode(value: string | undefined, optionName: string): "private" | "shared" {
  const mode = normalizeMode(value);
  if (!mode) {
    throw new Error(`${optionName} must be "private" or "shared"`);
  }
  return mode;
}
