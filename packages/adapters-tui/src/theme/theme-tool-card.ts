import type { ToolCardThemeMode } from "@nanoboss/tui-extension-sdk";

type Rgb = readonly [number, number, number];

interface ToolCardPalette {
  background: Rgb;
  border: Rgb;
  title: Rgb;
  meta: Rgb;
  body: Rgb;
  accent: Rgb;
  warning: Rgb;
  success: Rgb;
  error: Rgb;
  code: Rgb;
  syntaxComment: Rgb;
  syntaxKeyword: Rgb;
  syntaxFunction: Rgb;
  syntaxVariable: Rgb;
  syntaxString: Rgb;
  syntaxNumber: Rgb;
  syntaxType: Rgb;
  syntaxOperator: Rgb;
  syntaxPunctuation: Rgb;
}

const TOOL_CARD_PALETTE_BY_MODE: Record<ToolCardThemeMode, ToolCardPalette> = {
  dark: {
    background: [32, 32, 32],
    border: [148, 163, 184],
    title: [248, 250, 252],
    meta: [148, 163, 184],
    body: [229, 231, 235],
    accent: [125, 211, 252],
    warning: [253, 186, 116],
    success: [74, 222, 128],
    error: [248, 113, 113],
    code: [229, 192, 123],
    syntaxComment: [106, 153, 85],
    syntaxKeyword: [86, 156, 214],
    syntaxFunction: [220, 220, 170],
    syntaxVariable: [156, 220, 254],
    syntaxString: [206, 145, 120],
    syntaxNumber: [181, 206, 168],
    syntaxType: [78, 201, 176],
    syntaxOperator: [212, 212, 212],
    syntaxPunctuation: [212, 212, 212],
  },
  light: {
    background: [245, 245, 246],
    border: [100, 116, 139],
    title: [15, 23, 42],
    meta: [71, 85, 105],
    body: [31, 41, 55],
    accent: [3, 105, 161],
    warning: [146, 64, 14],
    success: [22, 101, 52],
    error: [153, 27, 27],
    code: [120, 53, 15],
    syntaxComment: [71, 85, 105],
    syntaxKeyword: [29, 78, 216],
    syntaxFunction: [109, 40, 217],
    syntaxVariable: [14, 116, 144],
    syntaxString: [154, 52, 18],
    syntaxNumber: [21, 101, 192],
    syntaxType: [6, 95, 70],
    syntaxOperator: [55, 65, 81],
    syntaxPunctuation: [55, 65, 81],
  },
};

export function getToolCardPalette(mode: ToolCardThemeMode): ToolCardPalette {
  return TOOL_CARD_PALETTE_BY_MODE[mode];
}

export function applyRgb(text: string, rgb: Rgb): string {
  return `\u001b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m${text}\u001b[39m`;
}

export function applyBoldRgb(text: string, rgb: Rgb): string {
  return `\u001b[1;38;2;${rgb[0]};${rgb[1]};${rgb[2]}m${text}\u001b[22;39m`;
}
