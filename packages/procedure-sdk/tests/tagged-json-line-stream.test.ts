import { describe, expect, test } from "bun:test";

import { createTaggedJsonLineStream } from "@nanoboss/procedure-sdk";

describe("createTaggedJsonLineStream", () => {
  test("renders text lines while extracting structured marker lines", () => {
    const markers: Array<{ type: string; phase?: string }> = [];
    const stream = createTaggedJsonLineStream<{ type: string; phase?: string }>({
      markerPrefix: "[[marker]] ",
      onMarker(marker) {
        markers.push(marker);
      },
    });

    const rendered = stream.consume(
      "alpha\n[[marker]] {\"type\":\"phase_start\",\"phase\":\"lint\"}\nbeta\n",
    );

    expect(rendered).toBe("alpha\nbeta\n");
    expect(markers).toEqual([{ type: "phase_start", phase: "lint" }]);
  });

  test("handles fragmented chunks and flushes trailing text", () => {
    const markers: Array<{ type: string; id: number }> = [];
    const stream = createTaggedJsonLineStream<{ type: string; id: number }>({
      markerPrefix: "[[marker]] ",
      onMarker(marker) {
        markers.push(marker);
      },
      renderTextLine(line, options) {
        return options.complete ? `${line.toUpperCase()}\n` : line.toUpperCase();
      },
    });

    expect(stream.consume("a")).toBe("");
    expect(stream.consume("lpha\n[[marker]] {\"type\":\"event\",\"id\":1}\nome")).toBe("ALPHA\n");
    expect(stream.flush()).toBe("OME");
    expect(markers).toEqual([{ type: "event", id: 1 }]);
  });

  test("ignores malformed marker payloads", () => {
    const stream = createTaggedJsonLineStream({
      markerPrefix: "[[marker]] ",
    });

    const rendered = stream.consume("[[marker]] {not json}\nplain\n");

    expect(rendered).toBe("plain\n");
  });
});
