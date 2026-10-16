import type { ReactNode } from "react";
import type { User } from "../lib/api";
import { initials, MOOD_LABELS } from "../lib/format";
import { keyLabel } from "../lib/keys";
import { cn } from "../lib/utils";
import { Kbd, KbdGroup } from "../ui/kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const HUES = [152, 28, 210, 330, 260, 90, 190];

function hueFor(seed: string) {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return HUES[hash % HUES.length]!;
}

export function Person({ name, seed, size = "sm", className }: { name: string; seed?: string; size?: "xs" | "sm" | "md"; className?: string }) {
  const hue = hueFor(seed ?? name);
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center rounded-full font-medium text-[oklch(0.38_0.07_var(--hue))] dark:text-[oklch(0.86_0.06_var(--hue))]",
        "bg-[oklch(0.93_0.035_var(--hue))] dark:bg-[oklch(0.32_0.04_var(--hue))]",
        size === "xs" && "size-4 text-[0.5rem]",
        size === "sm" && "size-5 text-[0.6rem]",
        size === "md" && "size-7 text-[0.7rem]",
        className,
      )}
      style={{ "--hue": hue } as React.CSSProperties}
    >
      {initials(name)}
    </span>
  );
}

export function Hotkey({ keys, className }: { keys: string; className?: string }) {
  return (
    <KbdGroup className={className}>
      {keyLabel(keys).map((part) => (
        <Kbd key={part}>{part}</Kbd>
      ))}
    </KbdGroup>
  );
}

export function Hint({ label, keys, children }: { label: string; keys?: string; children: React.ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipPopup className="flex items-center gap-2">
        {label}
        {keys ? <Hotkey keys={keys} /> : null}
      </TooltipPopup>
    </Tooltip>
  );
}

export function PageHeader({ title, children, description }: { title: string; description?: string; children?: ReactNode }) {
  return (
    <header className="flex h-12 shrink-0 items-center justify-between gap-4 border-b px-5">
      <div className="flex min-w-0 items-baseline gap-3">
        <h1 className="truncate font-medium text-[0.95rem]">{title}</h1>
        {description ? <p className="truncate text-muted-foreground text-sm">{description}</p> : null}
      </div>
      <div className="flex items-center gap-2">{children}</div>
    </header>
  );
}

export function nameOf(users: User[] | undefined, id: string | null) {
  if (!id) return null;
  return users?.find((user) => user.id === id)?.name ?? null;
}

const MOOD_TONES: Record<string, string> = {
  happy: "bg-success",
  calm: "bg-muted-foreground/45",
  confused: "bg-info",
  worried: "bg-warning",
  frustrated: "bg-[oklch(0.68_0.16_50)]",
  angry: "bg-destructive",
};

/** A quiet tag for the customer's mood: a colored dot and the word, so color is never the only signal. */
export function MoodTag({ mood, className }: { mood: string | null | undefined; className?: string }) {
  if (!mood || !MOOD_LABELS[mood]) return null;
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1 text-muted-foreground text-xs", className)} title={`Customer mood: ${MOOD_LABELS[mood]}`}>
      <span className={cn("size-1.5 rounded-full", MOOD_TONES[mood])} aria-hidden="true" />
      {MOOD_LABELS[mood]}
    </span>
  );
}
