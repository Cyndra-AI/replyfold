import { useEffect, useRef } from "react";

export type Shortcut = { keys: string; label: string; group: string; run: () => void; allowInInput?: boolean };

function typing(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

function chord(event: KeyboardEvent) {
  const parts: string[] = [];
  if (event.metaKey || event.ctrlKey) parts.push("mod");
  if (event.shiftKey && event.key.length > 1) parts.push("shift");
  if (event.altKey) parts.push("alt");
  parts.push(event.key.length === 1 ? event.key.toLowerCase() : event.key);
  return parts.join("+");
}

/**
 * Registers single keys ("j"), modified keys ("mod+enter") and two-key sequences
 * ("g i"). Sequences reset after one second. Shortcuts stay quiet while the user
 * types, unless a shortcut opts in.
 */
export function useShortcuts(shortcuts: Shortcut[], enabled = true) {
  const latest = useRef(shortcuts);
  latest.current = shortcuts;
  useEffect(() => {
    if (!enabled) return;
    let pending = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const key = chord(event);
      const inInput = typing(event.target);
      const candidates = latest.current.filter((shortcut) => !inInput || shortcut.allowInInput);
      const sequence = pending ? `${pending} ${key}` : key;
      const exact = candidates.find((shortcut) => shortcut.keys === sequence);
      if (exact) {
        event.preventDefault();
        pending = "";
        exact.run();
        return;
      }
      if (!pending && candidates.some((shortcut) => shortcut.keys.startsWith(`${key} `))) {
        pending = key;
        clearTimeout(timer);
        timer = setTimeout(() => (pending = ""), 1000);
        return;
      }
      pending = "";
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      clearTimeout(timer);
    };
  }, [enabled]);
}

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export function keyLabel(keys: string) {
  return keys.split(" ").map((part) =>
    part
      .split("+")
      .map((token) => (token === "mod" ? (isMac ? "⌘" : "Ctrl") : token === "Enter" ? "↵" : token === "Escape" ? "Esc" : token.length === 1 ? token.toUpperCase() : token))
      .join(""),
  );
}
