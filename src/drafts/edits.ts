import type { EditClass } from "../core/types";

const LIGHT_THRESHOLD = 0.8;

function words(text: string) {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
}

/** Share of words kept in order between two texts (LCS over words), from 0 to 1. */
export function similarity(a: string, b: string) {
  const left = words(a);
  const right = words(b);
  if (!left.length && !right.length) return 1;
  if (!left.length || !right.length) return 0;
  let previous = new Array<number>(right.length + 1).fill(0);
  for (const word of left) {
    const row = new Array<number>(right.length + 1).fill(0);
    for (let j = 1; j <= right.length; j += 1) {
      row[j] = word === right[j - 1] ? previous[j - 1]! + 1 : Math.max(previous[j]!, row[j - 1]!);
    }
    previous = row;
  }
  return previous[right.length]! / Math.max(left.length, right.length);
}

export function classifyEdit(draft: string, sent: string): EditClass {
  if (draft.replace(/\s+/g, " ").trim() === sent.replace(/\s+/g, " ").trim()) return "unchanged";
  return similarity(draft, sent) >= LIGHT_THRESHOLD ? "light" : "heavy";
}
