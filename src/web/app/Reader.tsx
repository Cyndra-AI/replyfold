import { ArrowLeftIcon, BellIcon, CheckIcon, ChevronDownIcon, CircleDotIcon, ClockIcon, PaperclipIcon, UserIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { api, type ConversationResponse, type ConversationStatus, type Message, type User } from "../lib/api";
import { CATEGORY_LABELS, fullTime, relativeTime } from "../lib/format";
import { useShortcuts } from "../lib/keys";
import { invalidate, useResource } from "../lib/resource";
import { navigate } from "../lib/router";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Menu, MenuGroupLabel, MenuItem, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Skeleton } from "../ui/skeleton";
import { toastManager } from "../ui/toast";
import { useSession } from "./App";
import { Hint, Person } from "./common";
import { Composer } from "./Composer";

const STATUS_LABELS: Record<ConversationStatus, string> = { open: "Open", waiting: "Waiting on customer", closed: "Closed" };
const STATUS_ICONS: Record<ConversationStatus, React.ReactNode> = {
  open: <CircleDotIcon className="text-brand" />,
  waiting: <ClockIcon />,
  closed: <CheckIcon />,
};

function MessageItem({ message, sender }: { message: Message; sender: string | null }) {
  const outbound = message.direction === "outbound";
  return (
    <article className="group/message border-b px-6 py-5 last:border-b-0">
      <header className="mb-2.5 flex items-center gap-2.5">
        <Person name={(outbound && sender) || message.from.name || message.from.email} seed={outbound && sender ? sender : message.from.email} size="md" />
        <div className="min-w-0 flex-1 leading-tight">
          <p className="truncate text-sm">
            <span className="font-medium">{outbound && sender ? sender : message.from.name || message.from.email}</span>
            <span className="text-muted-foreground"> {outbound ? `replied from ${message.from.email}` : message.from.email}</span>
          </p>
          {message.cc.length ? <p className="truncate text-muted-foreground text-xs">Cc {message.cc.map((entry) => entry.email).join(", ")}</p> : null}
        </div>
        <time className="tabular shrink-0 text-muted-foreground text-xs" dateTime={message.sentAt} title={fullTime(message.sentAt)}>
          {relativeTime(message.sentAt)}
        </time>
      </header>
      <div className="max-w-[70ch] whitespace-pre-wrap break-words pl-9.5 text-[0.875rem] text-foreground/90 leading-[1.6]">{message.text}</div>
      {message.attachments.length ? (
        <ul className="mt-3 flex flex-wrap gap-2 pl-9.5">
          {message.attachments.map((attachment) => (
            <li key={attachment.id}>
              <a
                href={`/api/attachments/${attachment.id}`}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs hover:bg-accent"
              >
                <PaperclipIcon className="size-3" />
                {attachment.filename}
                <span className="text-muted-foreground">{Math.max(1, Math.round(attachment.size / 1024))} KB</span>
              </a>
            </li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}

function ReaderSkeleton() {
  return (
    <div className="flex flex-col gap-3 p-6">
      <Skeleton className="h-5 w-2/5" />
      <Skeleton className="h-3 w-1/4" />
      <div className="mt-6 flex flex-col gap-2">
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-11/12" />
        <Skeleton className="h-3 w-3/5" />
      </div>
    </div>
  );
}

export function Reader({ conversationId, view, onRemoved }: { conversationId: string; view: string; onRemoved: () => void }) {
  const { user } = useSession();
  const path = `/api/conversations/${conversationId}`;
  const detail = useResource<ConversationResponse>(path);
  const team = useResource<{ users: User[] }>("/api/team");
  const [reminderOpen, setReminderOpen] = useState(false);
  const data = detail.data;
  const conversation = data?.conversation;

  async function update(patch: { status?: ConversationStatus; assigneeId?: string | null; category?: string }) {
    if (!conversation) return;
    await api(path, { method: "PATCH", body: patch });
    invalidate(path, "/api/inbox");
    if (patch.status === "closed" && view !== "closed" && view !== "all") {
      toastManager.add({ title: "Conversation closed", type: "success" });
      onRemoved();
    }
  }

  const unread = Boolean(conversation?.unread);
  useEffect(() => {
    if (unread) void api(path, { method: "PATCH", body: { unread: false } }).then(() => invalidate("/api/inbox"));
  }, [unread, path]);

  useShortcuts(
    [
      { keys: "e", label: "Close", group: "Conversation", run: () => void update({ status: "closed" }) },
      { keys: "i", label: "Assign to me", group: "Conversation", run: () => void update({ assigneeId: user.id }) },
    ],
    Boolean(conversation),
  );

  if (detail.error) return <p className="p-6 text-muted-foreground text-sm">{detail.error.message}</p>;
  if (!data || !conversation) return <ReaderSkeleton />;

  const users = team.data?.users ?? [];
  const assignee = users.find((member) => member.id === conversation.assigneeId);
  const senderName = (message: Message) => users.find((member) => member.id === message.sentByUserId)?.name ?? null;

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <Button variant="ghost" size="icon-xs" className="lg:hidden" aria-label="Back to the list" onClick={() => navigate(`/inbox/${view}`)}>
          <ArrowLeftIcon />
        </Button>
        <h2 className="min-w-0 flex-1 truncate font-medium text-[0.95rem]">{conversation.subject}</h2>
        <Menu>
          <Hint label="Assign" keys="i">
            <MenuTrigger render={<Button variant="ghost" size="xs" />}>
              {assignee ? <Person name={assignee.name} seed={assignee.id} size="xs" /> : <UserIcon />}
              <span className="max-sm:hidden">{assignee ? assignee.name : "Unassigned"}</span>
              <ChevronDownIcon className="opacity-60" />
            </MenuTrigger>
          </Hint>
          <MenuPopup align="end" className="w-52">
            <MenuRadioGroup value={conversation.assigneeId ?? ""} onValueChange={(value: string) => void update({ assigneeId: value || null })}>
              <MenuRadioItem value="">Unassigned</MenuRadioItem>
              {users.map((member) => (
                <MenuRadioItem key={member.id} value={member.id}>
                  {member.name}
                  {member.id === user.id ? <span className="text-muted-foreground">(you)</span> : null}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuPopup>
        </Menu>
        <Menu>
          <MenuTrigger render={<Button variant="ghost" size="xs" />}>
            {STATUS_ICONS[conversation.status]}
            <span className="max-sm:hidden">{STATUS_LABELS[conversation.status]}</span>
            <ChevronDownIcon className="opacity-60" />
          </MenuTrigger>
          <MenuPopup align="end" className="w-56">
            <MenuRadioGroup value={conversation.status} onValueChange={(value: ConversationStatus) => void update({ status: value })}>
              {(Object.keys(STATUS_LABELS) as ConversationStatus[]).map((status) => (
                <MenuRadioItem key={status} value={status}>
                  {STATUS_LABELS[status]}
                  {status === "closed" ? <span className="ms-auto text-muted-foreground text-xs">E</span> : null}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
            <MenuSeparator />
            <MenuGroupLabel>Category</MenuGroupLabel>
            <MenuRadioGroup value={conversation.category} onValueChange={(value: string) => void update({ category: value })}>
              {Object.entries(CATEGORY_LABELS).map(([value, label]) => (
                <MenuRadioItem key={value} value={value}>
                  {label}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
            <MenuSeparator />
            <MenuItem onClick={() => setReminderOpen(true)}>
              <BellIcon />
              Remind me
            </MenuItem>
          </MenuPopup>
        </Menu>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-6 py-3 text-sm">
          <span className="font-medium">{conversation.customer.name || conversation.customer.email}</span>
          <span className="text-muted-foreground">{conversation.customer.email}</span>
          <Badge variant="outline" size="sm">
            {CATEGORY_LABELS[conversation.category]}
          </Badge>
          {data.reminders
            .filter((reminder) => !reminder.doneAt)
            .map((reminder) => (
              <Badge key={reminder.id} variant="info" size="sm">
                <BellIcon />
                {new Date(reminder.dueAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}: {reminder.note}
              </Badge>
            ))}
        </div>
        {data.messages.map((message) => (
          <MessageItem key={message.id} message={message} sender={senderName(message)} />
        ))}
      </div>

      <Composer key={data.draft ? `${data.draft.id}:${data.draft.state}` : "manual"} data={data} path={path} reminderOpen={reminderOpen} onReminderOpenChange={setReminderOpen} />
    </div>
  );
}
