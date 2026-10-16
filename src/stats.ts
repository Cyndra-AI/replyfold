import type { Category, EditClass, Mood } from "./core/types";
import type { Store } from "./db/store";

export type Stats = {
  from: string;
  to: string;
  received: number;
  sent: number;
  edits: Record<EditClass | "manual", number>;
  medianFirstResponseMinutes: number | null;
  averageConfidence: number | null;
  daily: Array<{ date: string; received: number; sent: number }>;
  categories: Array<{ category: Category; count: number }>;
  /** Customer emails per mood. Emails that were never classified are left out. */
  moods: Array<{ mood: Mood; count: number }>;
  people: Array<{ userId: string; name: string; sent: number; unchanged: number; light: number; heavy: number }>;
};

function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function days(from: string, to: string) {
  const out: string[] = [];
  const end = Date.parse(to);
  for (let time = Date.parse(from.slice(0, 10)); time <= end; time += 86_400_000) out.push(new Date(time).toISOString().slice(0, 10));
  return out;
}

/** Reply volume and draft quality for a time range. Days are UTC calendar days. */
export function computeStats(store: Store, range: { from: string; to: string }): Stats {
  const { db } = store;
  const { from, to } = range;

  const perDay = db
    .query(
      `SELECT substr(sent_at, 1, 10) AS day, sum(direction = 'inbound') AS received, sum(direction = 'outbound') AS sent
       FROM messages WHERE sent_at >= ? AND sent_at <= ? GROUP BY day`,
    )
    .all(from, to) as Array<{ day: string; received: number; sent: number }>;
  const byDay = new Map(perDay.map((row) => [row.day, row]));
  const daily = days(from, to).map((date) => ({ date, received: byDay.get(date)?.received ?? 0, sent: byDay.get(date)?.sent ?? 0 }));

  const edits = db
    .query(
      `SELECT edit_class AS kind, count(*) AS n FROM drafts
       WHERE state = 'sent' AND updated_at >= ? AND updated_at <= ? GROUP BY edit_class`,
    )
    .all(from, to) as Array<{ kind: EditClass; n: number }>;
  const sentTotal = daily.reduce((sum, day) => sum + day.sent, 0);
  const editCounts = { unchanged: 0, light: 0, heavy: 0, manual: 0 };
  for (const row of edits) if (row.kind in editCounts) editCounts[row.kind] = row.n;
  const viaDraft = editCounts.unchanged + editCounts.light + editCounts.heavy;
  editCounts.manual = Math.max(0, sentTotal - viaDraft);

  const responses = db
    .query(
      `SELECT (julianday(min(reply.sent_at)) - julianday(first.sent_at)) * 1440 AS minutes
       FROM (SELECT conversation_id, min(sent_at) AS sent_at FROM messages WHERE direction = 'inbound' AND sent_at >= ? AND sent_at <= ? GROUP BY conversation_id) AS first
       JOIN messages AS reply ON reply.conversation_id = first.conversation_id AND reply.direction = 'outbound' AND reply.sent_at > first.sent_at
       GROUP BY first.conversation_id`,
    )
    .all(from, to) as Array<{ minutes: number }>;

  const confidence = db
    .query(
      `SELECT avg(json_extract(analysis_json, '$.confidence')) AS value FROM drafts
       WHERE analysis_json IS NOT NULL AND analysis_json != 'null' AND created_at >= ? AND created_at <= ?`,
    )
    .get(from, to) as { value: number | null };

  const categories = db
    .query(
      `SELECT category, count(*) AS count FROM conversations WHERE last_inbound_at >= ? AND last_inbound_at <= ?
       GROUP BY category ORDER BY count DESC`,
    )
    .all(from, to) as Array<{ category: Category; count: number }>;

  const moods = db
    .query(
      `SELECT mood, count(*) AS count FROM messages WHERE direction = 'inbound' AND mood IS NOT NULL AND sent_at >= ? AND sent_at <= ?
       GROUP BY mood ORDER BY count DESC`,
    )
    .all(from, to) as Stats["moods"];

  const people = db
    .query(
      `SELECT users.id AS userId, users.name AS name, count(sends.id) AS sent,
         sum(drafts.edit_class = 'unchanged') AS unchanged, sum(drafts.edit_class = 'light') AS light, sum(drafts.edit_class = 'heavy') AS heavy
       FROM sends JOIN users ON users.id = sends.user_id LEFT JOIN drafts ON drafts.id = sends.draft_id
       WHERE sends.state = 'sent' AND sends.created_at >= ? AND sends.created_at <= ?
       GROUP BY users.id ORDER BY sent DESC`,
    )
    .all(from, to) as Stats["people"];

  return {
    from,
    to,
    received: daily.reduce((sum, day) => sum + day.received, 0),
    sent: sentTotal,
    edits: editCounts,
    medianFirstResponseMinutes: median(responses.map((row) => row.minutes)),
    averageConfidence: confidence.value,
    daily,
    categories,
    moods,
    people: people.map((person) => ({
      ...person,
      unchanged: person.unchanged ?? 0,
      light: person.light ?? 0,
      heavy: person.heavy ?? 0,
    })),
  };
}
