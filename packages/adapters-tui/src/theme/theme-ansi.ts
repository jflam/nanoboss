export function style(text: string, codes: number[], resetCodes: number[]): string {
  if (text.length === 0) {
    return text;
  }

  return `\u001b[${codes.join(";")}m${text}\u001b[${resetCodes.join(";")}m`;
}

export function fgStyle(text: string, ...codes: number[]): string {
  return style(text, codes, [39]);
}

export function rgbBgStyle(text: string, red: number, green: number, blue: number): string {
  return style(text, [48, 2, red, green, blue], [49]);
}

export function attrStyle(text: string, code: number, resetCode: number): string {
  return style(text, [code], [resetCode]);
}
