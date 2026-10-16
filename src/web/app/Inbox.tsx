import { AlertTriangleIcon, InboxIcon, ListFilterIcon, RefreshCwIcon, SearchIcon, SparklesIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, type InboxResponse, type InboxRow, type MailboxesResponse } from "../lib/api";
import { MOOD_LABELS, relativeTime, VIEW_LABELS } from "../lib/format";
import { useShortcuts } from "../lib/keys";
import { invalidate, useResource } from "../lib/resource";
import { Link, navigate } from "../lib/router";
import { cn } from "../lib/utils";
import { Button } from "../ui/button";
import { Menu, MenuGroup, MenuGroupLabel, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Skeleton } from "../ui/skeleton";
import { Spinner } from "../ui/spinner";
import { Hint, Hotkey, MobileNav, MoodTag, Person } from "./common";
import { Reader } from "./Reader";

function DraftMark({ draft }: { draft: InboxRow["draft"] }) {
  if (!draft) return null;
  switch (draft.state) {
    case "queued":
    case "generating":
      return (
        <span className="flex items-center gap-1 text-muted-foreground text-xs">
          <Spinner className="size-3" />
          Writing
        </span>
      );
    case "ready":
      return draft.issues || draft.needsHuman ? (
        <span className="flex items-center gap-1 text-warning-foreground text-xs">
          <AlertTriangleIcon className="size-3" />
          Review
        </span>
      ) : (
        <span className="flex items-center gap-1 text-brand text-xs">
          <SparklesIcon className="size-3" />
          Draft
        </span>
      );
    case "failed":
      return <span className="text-destructive-foreground text-xs">Draft failed</span>;
    case "sent":
    case "discarded":
      return null;
    default: {
      const exhaustive: never = draft.state;
      return exhaustive;
    }
  }
}

function Row({ row, selected, view, names }: { row: InboxRow; selected: boolean; view: string; names: Map<string, string> }) {
  const assignee = row.assigneeId ? names.get(row.assigneeId) : null;
  return (
    <Link
      href={`/inbox/${view}/${row.id}`}
      data-row={row.id}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "relative grid h-16 grid-cols-[0.5rem_1fr] gap-x-2 border-b border-border/70 px-3 py-2.5 outline-none",
        "hover:bg-foreground/[0.03] focus-visible:bg-foreground/[0.04]",
        selected && "bg-brand-soft hover:bg-brand-soft",
      )}
    >
      <span className="pt-1.5">{row.unread ? <span className="block size-1.5 rounded-full bg-brand" aria-label="Unread" /> : null}</span>
      <span className="flex min-w-0 flex-col gap-1">
        <span className="flex items-center gap-2">
          <span className={cn("min-w-0 flex-1 truncate text-sm", row.unread ? "font-semibold" : "font-medium text-foreground/88")}>
            {row.customer.name || row.customer.email}
          </span>
          <MoodTag mood={row.mood} />
          {assignee ? <Person name={assignee} seed={row.assigneeId!} size="xs" /> : null}
          <time className="tabular shrink-0 text-muted-foreground text-xs" dateTime={row.lastMessageAt}>
            {relativeTime(row.lastMessageAt)}
          </time>
        </span>
        <span className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-muted-foreground text-sm">
            <span className="text-foreground/80">{row.subject}</span>
            <span className="text-muted-foreground/80"> {row.snippet}</span>
          </span>
          <DraftMark draft={row.draft} />
        </span>
      </span>
    </Link>
  );
}

function ListSkeleton() {
  return (
    <div className="flex flex-col">
      {Array.from({ length: 8 }, (_, index) => (
        <div key={index} className="flex h-16 flex-col justify-center gap-2 border-b px-5">
          <Skeleton className="h-3 w-1/3" />
          <Skeleton className="h-3 w-4/5" />
        </div>
      ))}
    </div>
  );
}

export function Inbox({ view, conversationId }: { view: string; conversationId: string | null }) {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [mood, setMood] = useState("");
  const [syncing, setSyncing] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 200);
    return () => clearTimeout(timer);
  }, [query]);
  const path = `/api/inbox?view=${view}${debounced ? `&q=${encodeURIComponent(debounced)}` : ""}${mood ? `&mood=${mood}` : ""}`;
  const inbox = useResource<InboxResponse>(path);
  const team = useResource<{ users: Array<{ id: string; name: string }> }>("/api/team");
  const mailboxes = useResource<MailboxesResponse>("/api/mailboxes");
  const rows = inbox.data?.conversations ?? [];
  const names = new Map((team.data?.users ?? []).map((user) => [user.id, user.name]));
  const index = rows.findIndex((row) => row.id === conversationId);

  const open = (offset: number) => {
    if (!rows.length) return;
    const next = rows[Math.min(Math.max((index < 0 ? -1 : index) + offset, 0), rows.length - 1)];
    if (next) navigate(`/inbox/${view}/${next.id}`, { replace: true });
  };

  useEffect(() => {
    if (!conversationId) return;
    document.querySelector(`[data-row="${conversationId}"]`)?.scrollIntoView({ block: "nearest" });
  }, [conversationId]);

  useShortcuts([
    { keys: "j", label: "Next conversation", group: "Inbox", run: () => open(1) },
    { keys: "ArrowDown", label: "Next conversation", group: "Inbox", run: () => open(1) },
    { keys: "k", label: "Previous conversation", group: "Inbox", run: () => open(-1) },
    { keys: "ArrowUp", label: "Previous conversation", group: "Inbox", run: () => open(-1) },
    { keys: "Enter", label: "Open", group: "Inbox", run: () => (index < 0 ? open(1) : undefined) },
    { keys: "Escape", label: "Back to the list", group: "Inbox", run: () => navigate(`/inbox/${view}`) },
    { keys: "/", label: "Search", group: "Inbox", run: () => searchRef.current?.focus() },
  ]);

  async function syncNow() {
    setSyncing(true);
    try {
      for (const mailbox of mailboxes.data?.mailboxes ?? []) await api(`/api/mailboxes/${mailbox.id}/sync`, { method: "POST", body: {} });
      invalidate("/api/inbox");
    } finally {
      setSyncing(false);
    }
  }

  const noMailbox = mailboxes.data && mailboxes.data.mailboxes.length === 0;
  const afterRemove = () => {
    const next = rows[index + 1] ?? rows[index - 1];
    navigate(next ? `/inbox/${view}/${next.id}` : `/inbox/${view}`, { replace: true });
  };

  return (
    <div className="flex min-h-0 flex-1">
      <section className={cn("flex w-full min-w-0 flex-col border-r bg-canvas lg:w-[25rem] lg:shrink-0", conversationId && "hidden lg:flex")} aria-label="Conversations">
        <header className="flex h-12 shrink-0 items-center justify-between gap-2 border-b px-4">
          <MobileNav />
          <h1 className="flex flex-1 items-baseline gap-2 font-medium text-[0.95rem]">
            {VIEW_LABELS[view] ?? "Inbox"}
            <span className="tabular font-normal text-muted-foreground text-xs">{inbox.data ? rows.length : ""}</span>
          </h1>
          <Menu>
            <Hint label="Filter by mood">
              <MenuTrigger render={<Button variant="ghost" size="icon-xs" aria-label="Filter by mood" className={cn(mood && "text-brand")} />}>
                <ListFilterIcon />
              </MenuTrigger>
            </Hint>
            <MenuPopup align="end" className="w-48">
              <MenuGroup>
                <MenuGroupLabel>Customer mood</MenuGroupLabel>
                <MenuRadioGroup value={mood} onValueChange={(value: string) => setMood(value)}>
                  <MenuRadioItem value="" closeOnClick>
                    Any mood
                  </MenuRadioItem>
                  {Object.keys(MOOD_LABELS).map((value) => (
                    <MenuRadioItem key={value} value={value} closeOnClick>
                      <MoodTag mood={value} className="text-foreground text-sm" />
                    </MenuRadioItem>
                  ))}
                </MenuRadioGroup>
              </MenuGroup>
            </MenuPopup>
          </Menu>
          <Hint label="Check for new mail">
            <Button variant="ghost" size="icon-xs" aria-label="Check for new mail" onClick={() => void syncNow()} disabled={syncing}>
              <RefreshCwIcon className={cn(syncing && "animate-spin")} />
            </Button>
          </Hint>
        </header>
        <div className="flex h-10 shrink-0 items-center gap-2 border-b px-4">
          <SearchIcon className="size-3.5 text-muted-foreground" />
          <input
            ref={searchRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setQuery("");
                event.currentTarget.blur();
              }
            }}
            placeholder="Search by name, email or text"
            aria-label="Search conversations"
            className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/80"
          />
          {query ? (
            <button type="button" aria-label="Clear search" onClick={() => setQuery("")} className="text-muted-foreground hover:text-foreground">
              <XIcon className="size-3.5" />
            </button>
          ) : (
            <Hotkey keys="/" />
          )}
        </div>
        {mood ? (
          <div className="flex h-9 shrink-0 items-center gap-2 border-b px-4 text-sm">
            <span className="text-muted-foreground">Mood:</span>
            <MoodTag mood={mood} className="text-foreground text-sm" />
            <button type="button" onClick={() => setMood("")} className="ms-auto flex items-center gap-1 text-muted-foreground text-xs hover:text-foreground">
              <XIcon className="size-3" />
              Clear filter
            </button>
          </div>
        ) : null}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {!inbox.data ? (
            <ListSkeleton />
          ) : rows.length ? (
            rows.map((row) => <Row key={row.id} row={row} selected={row.id === conversationId} view={view} names={names} />)
          ) : (
            <Empty className="h-full">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <InboxIcon />
                </EmptyMedia>
                <EmptyTitle>{debounced || mood ? "No matches" : noMailbox ? "Connect a mailbox" : "Nothing here"}</EmptyTitle>
                <EmptyDescription>
                  {mood && !debounced ? (
                    `No conversation in this view has a ${MOOD_LABELS[mood]?.toLowerCase()} customer. Clear the filter to see all of them.`
                  ) : debounced ? (
                    "Try a customer's name, their email address, or a word from the message."
                  ) : noMailbox ? (
                    <>
                      New customer email shows up here after you <Link className="text-foreground underline underline-offset-3" href="/settings/mailboxes">connect Gmail, Outlook or any IMAP mailbox</Link>.
                    </>
                  ) : (
                    "Every conversation in this view is handled."
                  )}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </div>
      </section>
      <section className={cn("min-w-0 flex-1", !conversationId && "hidden lg:flex")} aria-label="Conversation">
        {conversationId ? (
          <Reader key={conversationId} conversationId={conversationId} view={view} onRemoved={afterRemove} />
        ) : (
          <div className="flex h-full flex-1 flex-col items-center justify-center gap-3 text-center">
            <p className="text-muted-foreground text-sm">Select a conversation, or press J to open the first one.</p>
            <p className="flex items-center gap-1.5 text-muted-foreground text-xs">
              Press <Hotkey keys="?" /> for every shortcut
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
