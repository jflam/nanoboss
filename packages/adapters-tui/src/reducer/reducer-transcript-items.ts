import type { UiTranscriptItem } from "../state/state.ts";

export function appendTranscriptItem(
  items: UiTranscriptItem[],
  nextItem: UiTranscriptItem,
): UiTranscriptItem[] {
  const exists = items.some((item) => item.type === nextItem.type && item.id === nextItem.id);
  return exists ? items : [...items, nextItem];
}

export function removeTranscriptItem(
  items: UiTranscriptItem[],
  type: UiTranscriptItem["type"],
  id: string,
): UiTranscriptItem[] {
  return items.filter((item) => !(item.type === type && item.id === id));
}
