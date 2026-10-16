const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;

/** "4m", "3h", "Yesterday", "Mar 4". Short enough for a list row. */
export function relativeTime(iso: string, now = Date.now()) {
  const time = Date.parse(iso);
  const delta = now - time;
  if (delta < minute) return "now";
  if (delta < hour) return `${Math.floor(delta / minute)}m`;
  if (delta < day) return `${Math.floor(delta / hour)}h`;
  if (delta < 2 * day) return "Yesterday";
  if (delta < 7 * day) return new Date(time).toLocaleDateString(undefined, { weekday: "short" });
  return new Date(time).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function fullTime(iso: string) {
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? (parts.at(-1)?.[0] ?? "") : "")).toUpperCase() || "?";
}

export function firstName(name: string) {
  return name.trim().split(/\s+/)[0] ?? "";
}

export function formatMinutes(minutes: number | null) {
  if (minutes === null) return "No replies yet";
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const hours = minutes / 60;
  return hours < 24 ? `${hours.toFixed(1)} h` : `${(hours / 24).toFixed(1)} d`;
}

export const CATEGORY_LABELS: Record<string, string> = {
  shipping: "Shipping",
  billing: "Billing",
  returns: "Returns",
  account: "Account",
  product: "Product",
  feedback: "Feedback",
  other: "Other",
};

export const MOOD_LABELS: Record<string, string> = {
  happy: "Happy",
  calm: "Calm",
  confused: "Confused",
  worried: "Worried",
  frustrated: "Frustrated",
  angry: "Angry",
};

export const VIEW_LABELS: Record<string, string> = {
  mine: "Assigned to me",
  unassigned: "Unassigned",
  open: "Open",
  waiting: "Waiting on customer",
  closed: "Closed",
  all: "All conversations",
};

export const PROVIDER_LABELS: Record<string, string> = {
  gmail: "Gmail",
  microsoft: "Microsoft 365",
  imap: "IMAP and SMTP",
  demo: "Demo mailbox",
};
