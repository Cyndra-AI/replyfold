import { SendIcon } from "lucide-react";
import { useRef, useState } from "react";
import { api, newKey, type MailboxesResponse, type SendOutcome } from "../lib/api";
import { useShortcuts } from "../lib/keys";
import { invalidate, useResource } from "../lib/resource";
import { Link, navigate } from "../lib/router";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { Hotkey, PageHeader } from "./common";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parseRecipients(raw: string) {
  const tokens = raw.split(/[\s,;]+/).map((token) => token.trim()).filter(Boolean);
  const unique = [...new Set(tokens.map((token) => token.toLowerCase()))];
  return { valid: unique.filter((token) => EMAIL.test(token)), invalid: unique.filter((token) => !EMAIL.test(token)) };
}

function Line({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex h-11 items-center gap-3 border-b px-5 text-sm">
      <span className="w-14 shrink-0 text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

export function Compose() {
  const mailboxes = useResource<MailboxesResponse>("/api/mailboxes");
  const [mailboxId, setMailboxId] = useState<string | null>(null);
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const keyRef = useRef<string | null>(null);
  const list = mailboxes.data?.mailboxes ?? [];
  const from = mailboxId ?? list[0]?.id ?? null;

  async function send() {
    const recipients = parseRecipients(to);
    const copies = parseRecipients(cc);
    if (!from) return setError("Connect a mailbox first.");
    if (!recipients.valid.length || recipients.invalid.length || copies.invalid.length) {
      return setError(`Check the addresses: ${[...recipients.invalid, ...copies.invalid].join(", ") || "add a recipient"}.`);
    }
    setSending(true);
    setError("");
    keyRef.current ??= newKey();
    try {
      const outcome = await api<SendOutcome>("/api/compose", {
        method: "POST",
        body: {
          mailboxId: from,
          to: recipients.valid.map((email) => ({ name: "", email })),
          cc: copies.valid.map((email) => ({ name: "", email })),
          subject,
          body,
          key: keyRef.current,
        },
      });
      if (outcome.state === "failed") {
        keyRef.current = null;
        return setError(outcome.error ?? "The mail server refused the message.");
      }
      invalidate("/api/inbox");
      toastManager.add({ title: outcome.state === "sent" ? "Email sent" : "This email may have been sent", type: outcome.state === "sent" ? "success" : "warning" });
      navigate(`/inbox/all/${outcome.conversationId}`);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The email was not sent.");
    } finally {
      setSending(false);
    }
  }

  useShortcuts([
    { keys: "mod+Enter", label: "Send", group: "Compose", run: () => void send(), allowInInput: true },
    { keys: "Escape", label: "Close", group: "Compose", run: () => history.back() },
  ]);

  if (mailboxes.data && !list.length) {
    return (
      <>
        <PageHeader title="New email" />
        <p className="p-6 text-muted-foreground text-sm">
          <Link className="text-foreground underline underline-offset-3" href="/settings/mailboxes">
            Connect a mailbox
          </Link>{" "}
          to send email.
        </p>
      </>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader title="New email" />
      <div className="flex min-h-0 w-full max-w-3xl flex-1 flex-col">
        <Line label="From">
          <Select value={from} onValueChange={(value: string | null) => setMailboxId(value)} items={list.map((mailbox) => ({ value: mailbox.id, label: `${mailbox.displayName} <${mailbox.address}>` }))}>
            <SelectTrigger size="sm" className="w-auto min-w-64 border-0 bg-transparent shadow-none before:hidden">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {list.map((mailbox) => (
                <SelectItem key={mailbox.id} value={mailbox.id}>
                  {mailbox.displayName} &lt;{mailbox.address}&gt;
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </Line>
        <Line label="To">
          <input autoFocus value={to} onChange={(event) => setTo(event.target.value)} placeholder="customer@example.com" className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground/70" />
        </Line>
        <Line label="Cc">
          <input value={cc} onChange={(event) => setCc(event.target.value)} className="min-w-0 flex-1 bg-transparent outline-none" />
        </Line>
        <Line label="Subject">
          <input value={subject} onChange={(event) => setSubject(event.target.value)} placeholder="Your replacement is on its way" className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground/70" />
        </Line>
        <textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          aria-label="Message"
          placeholder="Write your message. Your signature is added when it sends."
          className="min-h-48 flex-1 resize-none bg-transparent px-5 py-4 text-[0.875rem] leading-[1.6] outline-none placeholder:text-muted-foreground/70"
        />
        <footer className="flex items-center gap-3 border-t px-5 py-3">
          <Button onClick={() => void send()} loading={sending} disabled={!to.trim() || !subject.trim() || !body.trim()} className="pressable">
            <SendIcon />
            Send
            <Hotkey keys="mod+Enter" className="opacity-80 [&_kbd]:border-white/20 [&_kbd]:bg-white/12 [&_kbd]:text-primary-foreground" />
          </Button>
          {error ? <p className="text-destructive-foreground text-sm">{error}</p> : null}
        </footer>
      </div>
    </div>
  );
}
