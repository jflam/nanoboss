import { createMarkdownStreamer, render } from "markdansi";

function getTerminalWidth(): number {
  const columns = process.stdout.columns;
  return typeof columns === "number" && columns > 0 ? columns : 80;
}

export function renderTerminalMarkdown(markdown: string): string {
  return render(markdown, {
    color: process.stdout.isTTY,
    hyperlinks: process.stdout.isTTY,
    width: getTerminalWidth(),
  });
}

export class StreamingTerminalMarkdownRenderer {
  private readonly streamer = createMarkdownStreamer({
    render: renderTerminalMarkdown,
  });

  push(text: string): string {
    return this.streamer.push(text);
  }

  finish(): string {
    return this.streamer.finish();
  }
}
