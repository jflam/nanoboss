import { Container, Markdown, Spacer, Text, type Component } from "../shared/pi-tui.ts";
import type { UiTurn } from "../state/state.ts";
import type { NanobossTuiTheme } from "../theme/theme.ts";
import { MessageCardComponent } from "../components/message-card.ts";

export function renderTurnLabel(theme: NanobossTuiTheme, turn: UiTurn): string {
  switch (turn.role) {
    case "user":
      return theme.accent("you");
    case "assistant":
      return turn.status === "failed"
        ? theme.error("nanoboss")
        : turn.status === "cancelled"
          ? theme.warning("nanoboss")
          : theme.success("nanoboss");
    case "system":
      return theme.warning("system");
  }
}

export function renderTurnBody(theme: NanobossTuiTheme, turn: UiTurn): Component {
  if (turn.role === "assistant") {
    if (turn.displayStyle === "card") {
      return renderMessageCard(theme, turn.markdown, turn.cardTone ?? inferTurnCardTone(turn));
    }

    const container = new Container();
    const textBlocks = (turn.blocks ?? []).filter(
      (block): block is Extract<NonNullable<UiTurn["blocks"]>[number], { kind: "text" }> =>
        block.kind === "text",
    );
    const bodyText = textBlocks.length > 0
      ? textBlocks.map((block) => block.text).join("")
      : turn.markdown;
    container.addChild(bodyText.length === 0
      ? new Text(theme.dim("…"))
      : new Markdown(bodyText, 0, 0, theme.markdown, {
          color: theme.text,
        }));

    if (turn.meta?.statusMessage) {
      container.addChild(new Spacer(1));
      container.addChild(renderMessageCard(theme, turn.meta.statusMessage, "warning"));
    }

    if (turn.meta?.failureMessage) {
      container.addChild(new Spacer(1));
      container.addChild(renderMessageCard(theme, `Error: ${turn.meta.failureMessage}`, "error"));
    }

    if (turn.meta?.completionNote) {
      container.addChild(new Spacer(1));
      container.addChild(renderMessageCard(theme, turn.meta.completionNote, "info"));
    }

    return container;
  }

  if (turn.role === "system") {
    return renderMessageCard(
      theme,
      turn.markdown,
      turn.status === "failed" ? "error" : (turn.cardTone ?? "warning"),
    );
  }

  return new Text(turn.markdown);
}

function renderMessageCard(
  theme: NanobossTuiTheme,
  markdown: string,
  tone: NonNullable<UiTurn["cardTone"]>,
): Component {
  const lines = markdown.length === 0 ? ["…"] : markdown.split("\n");
  return new MessageCardComponent(theme, lines, tone);
}

function inferTurnCardTone(turn: UiTurn): NonNullable<UiTurn["cardTone"]> {
  if (turn.status === "failed") {
    return "error";
  }

  if (turn.status === "cancelled") {
    return "warning";
  }

  if (turn.status === "complete") {
    return "success";
  }

  return "info";
}
