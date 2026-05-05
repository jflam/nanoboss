interface SseMessage {
  id?: string;
  event?: string;
  data: string;
}

export async function parseSseStream(
  stream: ReadableStream<Uint8Array>,
  onMessage: (message: SseMessage) => void,
  signal?: AbortSignal,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const handleAbort = () => {
    void reader.cancel().catch(() => {});
  };

  signal?.addEventListener("abort", handleAbort, { once: true });

  try {
    for (;;) {
      if (signal?.aborted) {
        return;
      }

      const { done, value } = await reader.read();
      if (done || signal?.aborted) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      for (;;) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary === -1) {
          break;
        }

        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const parsed = parseSseMessage(rawEvent);
        if (parsed) {
          onMessage(parsed);
        }
      }
    }

    if (!signal?.aborted) {
      buffer += decoder.decode();
      const parsed = parseSseMessage(buffer.trim());
      if (parsed) {
        onMessage(parsed);
      }
    }
  } finally {
    signal?.removeEventListener("abort", handleAbort);
    reader.releaseLock();
  }
}

function parseSseMessage(rawEvent: string): SseMessage | undefined {
  const trimmed = rawEvent.trim();
  if (!trimmed || trimmed.startsWith(":")) {
    return undefined;
  }

  const data: string[] = [];
  let id: string | undefined;
  let event: string | undefined;

  for (const line of trimmed.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) {
      continue;
    }

    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? "" : line.slice(separator + 1).replace(/^ /, "");

    switch (field) {
      case "id":
        id = value;
        break;
      case "event":
        event = value;
        break;
      case "data":
        data.push(value);
        break;
      default:
        break;
    }
  }

  if (data.length === 0) {
    return undefined;
  }

  return {
    id,
    event,
    data: data.join("\n"),
  };
}
