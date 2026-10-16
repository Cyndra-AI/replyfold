import { AlertTriangleIcon, ChevronDownIcon, ChevronRightIcon, RotateCcwIcon, SendIcon, SparklesIcon, Trash2Icon, WandSparklesIcon } from "lucide-react";
import { useRef, useState } from "react";
import { api, newKey, type ConversationResponse, type DiscardReason, type SendOutcome } from "../lib/api";
import { useShortcuts } from "../lib/keys";
import { invalidate } from "../lib/resource";
import { cn } from "../lib/utils";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { Dialog, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Skeleton } from "../ui/skeleton";
import { toastManager } from "../ui/toast";
import { Hint, Hotkey } from "./common";

const DISCARD_LABELS: Array<[DiscardReason, string]> = [
  ["wrong_facts", "The facts are wrong"],
  ["wrong_tone", "The tone is wrong"],
  ["missing_info", "It misses information"],
  ["not_needed", "No reply is needed"],
  ["other", "Another reason"],
];

const ASSISTS = [
  { task: "improve", label: "Improve" },
  { task: "shorten", label: "Shorter" },
  { task: "warmer", label: "Warmer" },
] as const;

function WhyThisDraft({ analysis }: { analysis: NonNullable<ConversationResponse["draft"]>["analysis"] }) {
  if (!analysis) return null;
  return (
    <dl className="mb-2 grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1.5 rounded-lg border bg-background px-3 py-2.5 text-xs">
      <dt className="text-muted-foreground">Summary</dt>
      <dd>{analysis.summary}</dd>
      <dt className="text-muted-foreground">Customer wants</dt>
      <dd>{analysis.intent}</dd>
      {analysis.missingInformation.length ? (
        <>
          <dt className="text-muted-foreground">Missing</dt>
          <dd>{analysis.missingInformation.join("; ")}</dd>
        </>
      ) : null}
      {analysis.facts.length ? (
        <>
          <dt className="text-muted-foreground">Relies on</dt>
          <dd>{analysis.facts.map((fact) => fact.claim).join("; ")}</dd>
        </>
      ) : null}
    </dl>
  );
}

function ReminderDialog({ open, onOpenChange, path }: { open: boolean; onOpenChange: (open: boolean) => void; path: string }) {
  const [note, setNote] = useState("");
  const [days, setDays] = useState(1);
  async function save() {
    const due = new Date();
    due.setDate(due.getDate() + days);
    due.setHours(9, 0, 0, 0);
    await api(`${path}/reminders`, { method: "POST", body: { dueAt: due.toISOString(), note: note.trim() || "Follow up" } });
    invalidate(path, "/api/inbox");
    toastManager.add({ title: "Reminder set", description: `The conversation reopens on ${due.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })}.`, type: "success" });
    setNote("");
    onOpenChange(false);
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Remind me</DialogTitle>
          <DialogDescription>The conversation waits until then, and comes back to the open view at 9:00.</DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-3">
          <div className="grid grid-cols-3 gap-1.5">
            {[
              [1, "Tomorrow"],
              [3, "In 3 days"],
              [7, "Next week"],
            ].map(([value, label]) => (
              <Button key={value} variant={days === value ? "secondary" : "outline"} size="sm" onClick={() => setDays(Number(value))} aria-pressed={days === value}>
                {label}
              </Button>
            ))}
          </div>
          <Input value={note} onChange={(event) => setNote(event.target.value)} placeholder="Check that the refund posted" aria-label="Reminder note" />
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
          <Button onClick={() => void save()}>Set reminder</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function Composer({
  data,
  path,
  reminderOpen,
  onReminderOpenChange,
}: {
  data: ConversationResponse;
  path: string;
  reminderOpen: boolean;
  onReminderOpenChange: (open: boolean) => void;
}) {
  const draft = data.draft && data.draft.state !== "sent" ? data.draft : null;
  const [body, setBody] = useState(draft?.state === "ready" ? draft.body : "");
  const [manual, setManual] = useState(false);
  const [sending, setSending] = useState(false);
  const [assisting, setAssisting] = useState<string | null>(null);
  const [instruction, setInstruction] = useState("");
  const [rewriteOpen, setRewriteOpen] = useState(false);
  const [whyOpen, setWhyOpen] = useState(false);
  const keyRef = useRef<string | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const uncertain = data.sends.find((send) => send.state === "uncertain");
  const writing = draft?.state === "queued" || draft?.state === "generating";
  const noReply = draft?.state === "ready" && !draft.body && draft.analysis?.disposition === "no_reply" && !manual;
  const editable = !writing && !noReply && draft?.state !== "failed";
  const usingDraft = draft?.state === "ready" && Boolean(draft.body);
  const customerWroteLast = data.messages.at(-1)?.direction === "inbound";

  async function send() {
    if (!body.trim() || sending) return;
    setSending(true);
    keyRef.current ??= newKey();
    try {
      const outcome = await api<SendOutcome>(`${path}/send`, { method: "POST", body: { body, draftId: usingDraft ? draft!.id : null, key: keyRef.current } });
      if (outcome.state === "sent") {
        keyRef.current = null;
        toastManager.add({ title: "Reply sent", description: `To ${data.conversation.customer.email}`, type: "success" });
      } else if (outcome.state === "failed") {
        keyRef.current = null;
        toastManager.add({ title: "The reply was not sent", description: outcome.error ?? undefined, type: "error" });
      }
      invalidate(path, "/api/inbox");
    } catch (error) {
      toastManager.add({ title: "The reply was not sent", description: error instanceof Error ? error.message : undefined, type: "error" });
    } finally {
      setSending(false);
    }
  }

  async function rewrite() {
    setRewriteOpen(false);
    await api(`${path}/draft`, { method: "POST", body: { instruction } }).catch((error: Error) =>
      toastManager.add({ title: "Could not start a new draft", description: error.message, type: "error" }),
    );
    setInstruction("");
    invalidate(path, "/api/inbox");
  }

  async function assist(task: (typeof ASSISTS)[number]["task"]) {
    setAssisting(task);
    try {
      const result = await api<{ text: string }>("/api/assist", { method: "POST", body: { conversationId: data.conversation.id, task, text: body } });
      setBody(result.text);
    } catch (error) {
      toastManager.add({ title: "The AI could not edit the reply", description: error instanceof Error ? error.message : undefined, type: "error" });
    } finally {
      setAssisting(null);
    }
  }

  async function discard(reason: DiscardReason) {
    await api(`${path}/discard`, { method: "POST", body: { reason } });
    setBody("");
    setManual(true);
    invalidate(path, "/api/inbox");
  }

  async function resolve(outcome: "sent" | "failed") {
    if (!uncertain) return;
    await api(`/api/sends/${uncertain.id}/resolve`, { method: "POST", body: { outcome } });
    invalidate(path, "/api/inbox");
  }

  useShortcuts([
    { keys: "mod+Enter", label: "Send", group: "Conversation", run: () => void send(), allowInInput: true },
    { keys: "r", label: "Edit the reply", group: "Conversation", run: () => textRef.current?.focus() },
    { keys: "shift+R", label: "Write again", group: "Conversation", run: () => customerWroteLast && setRewriteOpen(true) },
  ]);

  return (
    <div className="shrink-0 border-t bg-canvas px-4 pt-3 pb-4">
      <ReminderDialog open={reminderOpen} onOpenChange={onReminderOpenChange} path={path} />
      {uncertain ? (
        <Alert variant="warning" className="mb-3">
          <AlertTriangleIcon />
          <AlertTitle>This reply may already have been sent</AlertTitle>
          <AlertDescription>The mail server stopped answering after the message left. Check the mailbox's Sent folder, then say what you found.</AlertDescription>
          <AlertAction>
            <Button size="xs" variant="outline" onClick={() => void resolve("failed")}>
              It was not sent
            </Button>
            <Button size="xs" onClick={() => void resolve("sent")}>
              It was sent
            </Button>
          </AlertAction>
        </Alert>
      ) : null}

      <div className="mb-2 flex min-h-5 items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          {usingDraft || writing ? (
            <span className="flex items-center gap-1.5 font-medium text-xs">
              <SparklesIcon className="size-3.5 text-brand" />
              {writing ? "Writing a draft from your playbook" : "AI draft"}
            </span>
          ) : (
            <span className="font-medium text-xs">Reply</span>
          )}
          {usingDraft && draft!.analysis ? (
            <button
              type="button"
              onClick={() => setWhyOpen((value) => !value)}
              aria-expanded={whyOpen}
              className="flex items-center gap-1 text-muted-foreground text-xs outline-none hover:text-foreground focus-visible:text-foreground"
            >
              {whyOpen ? <ChevronDownIcon className="size-3" /> : <ChevronRightIcon className="size-3" />}
              Why this draft
            </button>
          ) : null}
        </div>
        {usingDraft && draft!.analysis ? (
          <span className="tabular text-muted-foreground text-xs">{Math.round(draft!.analysis.confidence * 100)}% confident</span>
        ) : null}
      </div>

      {usingDraft && whyOpen ? <WhyThisDraft analysis={draft!.analysis} /> : null}

      {usingDraft && draft!.issues.length ? (
        <ul className="mb-2 flex flex-col gap-1">
          {draft!.issues.map((issue) => (
            <li key={issue.code} className="flex items-start gap-1.5 text-warning-foreground text-xs">
              <AlertTriangleIcon className="mt-px size-3 shrink-0" />
              {issue.message}
            </li>
          ))}
        </ul>
      ) : null}

      {draft?.state === "failed" && !manual ? (
        <Alert variant="error">
          <AlertTitle>The draft could not be written</AlertTitle>
          <AlertDescription>{draft.error}</AlertDescription>
          <AlertAction>
            <Button size="xs" variant="outline" onClick={() => setManual(true)}>
              Write it myself
            </Button>
            <Button size="xs" onClick={() => void rewrite()}>
              Try again
            </Button>
          </AlertAction>
        </Alert>
      ) : noReply ? (
        <div className="flex items-center justify-between gap-3 rounded-lg border bg-background px-3 py-2.5 text-sm">
          <span className="text-muted-foreground">No reply needed. {draft?.analysis?.summary}</span>
          <Button size="xs" variant="outline" onClick={() => setManual(true)}>
            Write a reply anyway
          </Button>
        </div>
      ) : writing ? (
        <div className="flex flex-col gap-2 rounded-lg border bg-background px-3 py-3" aria-busy="true">
          <Skeleton className="h-3 w-1/4" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-11/12" />
          <Skeleton className="h-3 w-2/3" />
        </div>
      ) : null}

      {editable || manual ? (
        <div className="rounded-lg border bg-background shadow-xs/5 transition-shadow focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/24">
          <textarea
            ref={textRef}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            placeholder={`Write to ${data.conversation.customer.name || data.conversation.customer.email}`}
            aria-label="Reply"
            className="field-sizing-content block max-h-[42vh] min-h-32 w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-[0.875rem] leading-[1.6] outline-none placeholder:text-muted-foreground/72"
          />
          <div className="flex flex-wrap items-center gap-1 px-2 pb-2">
            {ASSISTS.map((item) => (
              <Button key={item.task} variant="ghost" size="xs" disabled={!body.trim() || Boolean(assisting)} loading={assisting === item.task} onClick={() => void assist(item.task)}>
                {item.task === "improve" ? <WandSparklesIcon /> : null}
                {item.label}
              </Button>
            ))}
            {customerWroteLast ? (
            <Popover open={rewriteOpen} onOpenChange={setRewriteOpen}>
              <Hint label="Write the draft again" keys="shift+R">
                <PopoverTrigger render={<Button variant="ghost" size="xs" />}>
                  <RotateCcwIcon />
                  Write again
                </PopoverTrigger>
              </Hint>
              <PopoverPopup align="start" className="w-80">
                <form
                  className="flex flex-col gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void rewrite();
                  }}
                >
                  <label htmlFor="rewrite-instruction" className="font-medium text-sm">
                    What should change?
                  </label>
                  <Input id="rewrite-instruction" autoFocus value={instruction} onChange={(event) => setInstruction(event.target.value)} placeholder="Offer express shipping at no cost" />
                  <Button type="submit" size="sm" className="self-end">
                    Write again
                  </Button>
                </form>
              </PopoverPopup>
            </Popover>
            ) : null}
            <span className="flex-1" />
            {usingDraft ? (
              <Menu>
                <MenuTrigger render={<Button variant="ghost" size="icon-xs" aria-label="Discard the draft" />}>
                  <Trash2Icon />
                </MenuTrigger>
                <MenuPopup align="end" className="w-56">
                  <p className="px-2 py-1.5 text-muted-foreground text-xs">Why discard it? This teaches the drafts.</p>
                  {DISCARD_LABELS.map(([reason, label]) => (
                    <MenuItem key={reason} onClick={() => void discard(reason)}>
                      {label}
                    </MenuItem>
                  ))}
                </MenuPopup>
              </Menu>
            ) : null}
            <Button size="sm" onClick={() => void send()} loading={sending} disabled={!body.trim()} className={cn("pressable gap-2")}>
              <SendIcon />
              Send
              <Hotkey keys="mod+Enter" className="opacity-80 [&_kbd]:border-white/20 [&_kbd]:bg-white/12 [&_kbd]:text-primary-foreground" />
            </Button>
          </div>
        </div>
      ) : null}
      {editable || manual ? (
        <p className="mt-2 text-muted-foreground text-xs">
          Sends from {data.mailbox?.address ?? "the mailbox"} with your signature. Nothing goes out until you press Send.
        </p>
      ) : null}
    </div>
  );
}
