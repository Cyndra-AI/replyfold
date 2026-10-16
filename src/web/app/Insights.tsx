import { useState } from "react";
import type { Stats } from "../lib/api";
import { CATEGORY_LABELS, formatMinutes } from "../lib/format";
import { useResource } from "../lib/resource";
import { cn } from "../lib/utils";
import { Skeleton } from "../ui/skeleton";
import { Tabs, TabsList, TabsTab } from "../ui/tabs";
import { PageHeader, Person } from "./common";

const SERIES = {
  received: { label: "Received", className: "fill-[#5B8FE0] dark:fill-[#5A88D8]", swatch: "bg-[#5B8FE0] dark:bg-[#5A88D8]" },
  sent: { label: "Sent", className: "fill-[#16856A] dark:fill-[#3BA886]", swatch: "bg-[#16856A] dark:bg-[#3BA886]" },
} as const;

const EDITS = [
  { key: "unchanged", label: "Sent as drafted", swatch: "bg-[#A7D8C6] dark:bg-[#2E6B57]" },
  { key: "light", label: "Lightly edited", swatch: "bg-[#4FAE8E] dark:bg-[#48A584]" },
  { key: "heavy", label: "Rewritten", swatch: "bg-[#16674F] dark:bg-[#9ED7C2]" },
  { key: "manual", label: "Written without a draft", swatch: "bg-[#B9BFBC] dark:bg-[#4A504D]" },
] as const;

function Figure({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="tabular mt-1 font-medium text-2xl tracking-[-0.02em]">{value}</dd>
      {note ? <dd className="mt-0.5 text-muted-foreground text-xs">{note}</dd> : null}
    </div>
  );
}

function DailyChart({ daily }: { daily: Stats["daily"] }) {
  const [hover, setHover] = useState<number | null>(null);
  const width = 720;
  const height = 180;
  const top = 12;
  const bottom = 24;
  const max = Math.max(4, ...daily.flatMap((day) => [day.received, day.sent]));
  const step = width / daily.length;
  const bar = Math.max(3, Math.min(14, step / 2 - 4));
  const y = (value: number) => top + (height - top - bottom) * (1 - value / max);
  const ticks = [0, Math.round(max / 2), max];
  const active = hover === null ? null : daily[hover];
  return (
    <figure className="relative">
      <figcaption className="mb-3 flex items-center justify-between">
        <span className="font-medium text-sm">Mail per day</span>
        <span className="flex items-center gap-4 text-muted-foreground text-xs">
          {Object.values(SERIES).map((series) => (
            <span key={series.label} className="flex items-center gap-1.5">
              <span className={cn("size-2 rounded-[2px]", series.swatch)} />
              {series.label}
            </span>
          ))}
        </span>
      </figcaption>
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full" role="img" aria-label="Mail received and sent per day">
        {ticks.map((tick) => (
          <g key={tick}>
            <line x1={0} x2={width} y1={y(tick)} y2={y(tick)} className="stroke-border" strokeWidth={1} />
            <text x={0} y={y(tick) - 3} className="fill-muted-foreground text-[10px]">
              {tick}
            </text>
          </g>
        ))}
        {daily.map((day, index) => {
          const center = step * index + step / 2;
          const label = new Date(`${day.date}T12:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
          return (
            <g key={day.date} onMouseEnter={() => setHover(index)} onMouseLeave={() => setHover(null)}>
              <rect x={step * index} y={0} width={step} height={height} className={cn("fill-transparent", hover === index && "fill-foreground/[0.035]")} />
              {(["received", "sent"] as const).map((key, offset) => {
                const value = day[key];
                const x = center - bar - 1 + offset * (bar + 2);
                const barTop = y(value);
                const h = y(0) - barTop;
                return value ? <path key={key} d={`M${x},${y(0)} V${barTop + 2} Q${x},${barTop} ${x + 2},${barTop} H${x + bar - 2} Q${x + bar},${barTop} ${x + bar},${barTop + 2} V${y(0)} Z`} className={SERIES[key].className} opacity={h > 0 ? 1 : 0} /> : null;
              })}
              {index % Math.ceil(daily.length / 7) === 0 || index === daily.length - 1 ? (
                <text x={center} y={height - 6} textAnchor="middle" className="fill-muted-foreground text-[10px]">
                  {label}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      {active && hover !== null ? (
        <div
          className="pointer-events-none absolute top-8 z-10 rounded-md border bg-popover px-2.5 py-1.5 text-xs shadow-md/5"
          style={{ left: `clamp(0px, calc(${((hover + 0.5) / daily.length) * 100}% - 4rem), calc(100% - 8rem))` }}
        >
          <p className="font-medium">{new Date(`${active.date}T12:00:00Z`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}</p>
          <p className="tabular text-muted-foreground">
            {active.received} received, {active.sent} sent
          </p>
        </div>
      ) : null}
    </figure>
  );
}

function EditQuality({ edits }: { edits: Stats["edits"] }) {
  const total = EDITS.reduce((sum, item) => sum + edits[item.key], 0);
  return (
    <section>
      <h2 className="font-medium text-sm">How much the team changed the drafts</h2>
      <p className="mt-0.5 mb-3 text-muted-foreground text-xs">Fewer rewrites means the playbook is doing its job.</p>
      <div className="flex h-2.5 gap-0.5 overflow-hidden rounded-full" role="img" aria-label="Share of replies by how much the draft was edited">
        {total
          ? EDITS.map((item) => (edits[item.key] ? <span key={item.key} className={item.swatch} style={{ flexGrow: edits[item.key] }} /> : null))
          : <span className="flex-1 bg-muted" />}
      </div>
      <ul className="mt-3 flex max-w-sm flex-col gap-1.5 text-sm">
        {EDITS.map((item) => (
          <li key={item.key} className="flex items-center gap-2">
            <span className={cn("size-2 rounded-[2px]", item.swatch)} />
            <span className="flex-1 text-muted-foreground">{item.label}</span>
            <span className="tabular">{edits[item.key]}</span>
            <span className="tabular w-10 text-right text-muted-foreground text-xs">{total ? `${Math.round((edits[item.key] / total) * 100)}%` : ""}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function Insights() {
  const [days, setDays] = useState("14");
  const stats = useResource<Stats>(`/api/stats?days=${days}`);
  const data = stats.data;
  const drafted = data ? data.edits.unchanged + data.edits.light + data.edits.heavy : 0;
  const maxCategory = Math.max(1, ...(data?.categories.map((item) => item.count) ?? [1]));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader title="Insights">
        <Tabs value={days} onValueChange={(value: string) => setDays(value)}>
          <TabsList>
            <TabsTab value="1">Today</TabsTab>
            <TabsTab value="7">7 days</TabsTab>
            <TabsTab value="14">14 days</TabsTab>
            <TabsTab value="30">30 days</TabsTab>
          </TabsList>
        </Tabs>
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!data ? (
          <div className="grid gap-4 p-6">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-48 w-full" />
          </div>
        ) : (
          <div className="mx-auto flex max-w-5xl flex-col gap-8 px-6 py-6">
            <dl className="grid grid-cols-2 gap-6 border-b pb-6 md:grid-cols-4">
              <Figure label="Customer emails" value={String(data.received)} />
              <Figure label="Replies sent" value={String(data.sent)} />
              <Figure label="Median first reply" value={formatMinutes(data.medianFirstResponseMinutes)} />
              <Figure
                label="Drafts sent with light or no edits"
                value={drafted ? `${Math.round(((data.edits.unchanged + data.edits.light) / drafted) * 100)}%` : "None yet"}
                note={data.averageConfidence !== null ? `Average draft confidence ${Math.round(data.averageConfidence * 100)}%` : undefined}
              />
            </dl>
            <DailyChart daily={data.daily} />
            <div className="grid gap-8 md:grid-cols-2">
              <EditQuality edits={data.edits} />
              <section>
                <h2 className="mb-3 font-medium text-sm">What customers wrote about</h2>
                <ul className="flex flex-col gap-2">
                  {data.categories.map((item) => (
                    <li key={item.category} className="grid grid-cols-[6rem_1fr_2rem] items-center gap-3 text-sm">
                      <span className="text-muted-foreground">{CATEGORY_LABELS[item.category]}</span>
                      <span className="h-1.5 rounded-full bg-muted">
                        <span className="block h-full rounded-full bg-[#16856A] dark:bg-[#3BA886]" style={{ width: `${(item.count / maxCategory) * 100}%` }} />
                      </span>
                      <span className="tabular text-right">{item.count}</span>
                    </li>
                  ))}
                  {!data.categories.length ? <li className="text-muted-foreground text-sm">No customer email in this range.</li> : null}
                </ul>
              </section>
            </div>
            <section>
              <h2 className="mb-3 font-medium text-sm">Replies by person</h2>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground text-xs">
                    <th className="pb-2 font-normal">Person</th>
                    <th className="pb-2 text-right font-normal">Sent</th>
                    <th className="pb-2 text-right font-normal">As drafted</th>
                    <th className="pb-2 text-right font-normal">Lightly edited</th>
                    <th className="pb-2 text-right font-normal">Rewritten</th>
                  </tr>
                </thead>
                <tbody className="tabular">
                  {data.people.map((person) => (
                    <tr key={person.userId} className="border-b last:border-b-0">
                      <td className="py-2">
                        <span className="flex items-center gap-2">
                          <Person name={person.name} seed={person.userId} />
                          {person.name}
                        </span>
                      </td>
                      <td className="py-2 text-right">{person.sent}</td>
                      <td className="py-2 text-right">{person.unchanged}</td>
                      <td className="py-2 text-right">{person.light}</td>
                      <td className="py-2 text-right">{person.heavy}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
