export interface TaggedJsonLineStream<TMarker> {
  consume(chunk: string): string;
  flush(): string;
}

export interface TaggedJsonLineStreamOptions<TMarker> {
  markerPrefix: string;
  parseMarker?: (payload: string) => TMarker | undefined;
  onMarker?: (marker: TMarker) => void;
  renderTextLine?: (line: string, options: { complete: boolean }) => string | undefined;
}

export function createTaggedJsonLineStream<TMarker = unknown>(
  options: TaggedJsonLineStreamOptions<TMarker>,
): TaggedJsonLineStream<TMarker> {
  let pendingLine = "";
  const parseMarker = options.parseMarker ?? parseJsonMarkerPayload<TMarker>;

  return {
    consume(chunk) {
      pendingLine += chunk;
      const completeLines = pendingLine.split(/\r?\n/);
      pendingLine = completeLines.pop() ?? "";

      let rendered = "";
      for (const line of completeLines) {
        rendered += processLine(line, true);
      }
      return rendered;
    },
    flush() {
      if (pendingLine.length === 0) {
        return "";
      }

      const line = pendingLine;
      pendingLine = "";
      return processLine(line, false);
    },
  };

  function processLine(line: string, complete: boolean): string {
    if (line.startsWith(options.markerPrefix)) {
      const marker = parseMarker(line.slice(options.markerPrefix.length));
      if (marker !== undefined) {
        options.onMarker?.(marker);
      }
      return "";
    }

    const rendered = options.renderTextLine?.(line, { complete });
    if (rendered !== undefined) {
      return rendered;
    }

    return complete ? `${line}\n` : line;
  }
}

function parseJsonMarkerPayload<TMarker>(payload: string): TMarker | undefined {
  try {
    return JSON.parse(payload) as TMarker;
  } catch {
    return undefined;
  }
}
