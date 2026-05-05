import type { MarkdownTheme, SelectListTheme } from "../shared/pi-tui.ts";
import {
  attrStyle,
  fgStyle,
  style,
} from "./theme-ansi.ts";

interface BaseTextStyles {
  text(value: string): string;
  accent(value: string): string;
  muted(value: string): string;
  dim(value: string): string;
  success(value: string): string;
  error(value: string): string;
  warning(value: string): string;
  bold(value: string): string;
  italic(value: string): string;
  underline(value: string): string;
}

export function createBaseTextStyles(): BaseTextStyles {
  return {
    text: (value) => value,
    accent: (value) => fgStyle(value, 36),
    muted: (value) => fgStyle(value, 90),
    dim: (value) => attrStyle(value, 2, 22),
    success: (value) => fgStyle(value, 32),
    error: (value) => fgStyle(value, 31),
    warning: (value) => fgStyle(value, 33),
    bold: (value) => attrStyle(value, 1, 22),
    italic: (value) => attrStyle(value, 3, 23),
    underline: (value) => attrStyle(value, 4, 24),
  };
}

export function createSelectListTheme(styles: BaseTextStyles): SelectListTheme {
  return {
    selectedPrefix: (value) => style(value, [1, 36], [22, 39]),
    selectedText: (value) => style(value, [1, 36], [22, 39]),
    description: styles.muted,
    scrollInfo: styles.dim,
    noMatch: styles.warning,
  };
}

export function createMarkdownTheme(styles: BaseTextStyles): MarkdownTheme {
  return {
    heading: (value) => style(value, [1, 36], [22, 39]),
    link: (value) => style(value, [4, 36], [24, 39]),
    linkUrl: styles.muted,
    code: (value) => styles.warning(value),
    codeBlock: styles.text,
    codeBlockBorder: styles.muted,
    quote: styles.muted,
    quoteBorder: styles.muted,
    hr: styles.muted,
    listBullet: styles.accent,
    bold: styles.bold,
    italic: styles.italic,
    strikethrough: (value) => attrStyle(value, 9, 29),
    underline: styles.underline,
  };
}
