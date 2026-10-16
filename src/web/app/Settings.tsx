import { MailIcon, PauseIcon, PlayIcon, RefreshCwIcon, ServerIcon, Trash2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import { api, type MailboxesResponse, type User } from "../lib/api";
import { fullTime, PROVIDER_LABELS, relativeTime } from "../lib/format";
import { invalidate, useResource } from "../lib/resource";
import { Link } from "../lib/router";
import { cn } from "../lib/utils";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Field, FieldDescription, FieldLabel } from "../ui/field";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { AiSettingsSection } from "./AiSettings";
import { useSession } from "./App";
import { PageHeader, Person } from "./common";

const SECTIONS = [
  { id: "mailboxes", label: "Mailboxes" },
  { id: "ai", label: "AI and classification" },
  { id: "team", label: "Team" },
  { id: "profile", label: "Profile and signature" },
] as const;

function Block({ title, description, children }: { title: string; description?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="border-b py-6 last:border-b-0">
      <h2 className="font-medium text-sm">{title}</h2>
      {description ? <p className="mt-1 max-w-[65ch] text-muted-foreground text-sm">{description}</p> : null}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function OAuthOption({ provider, label, help, configured, redirectUri, envNames, canConnect }: { provider: "gmail" | "microsoft"; label: string; help: string; configured: boolean; redirectUri: string; envNames: string; canConnect: boolean }) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border p-4">
      <div className="flex items-center gap-2.5">
        <MailIcon className="size-4 text-muted-foreground" />
        <p className="flex-1 font-medium text-sm">{label}</p>
        {configured ? (
          <Button size="sm" variant="outline" render={<a href={`/api/oauth/${provider}/start`} />} disabled={!canConnect}>
            Connect
          </Button>
        ) : (
          <Badge variant="outline">Needs setup</Badge>
        )}
      </div>
      <p className="text-muted-foreground text-xs leading-relaxed">{help}</p>
      {!configured ? (
        <ol className="list-decimal space-y-1 pl-4 text-muted-foreground text-xs leading-relaxed">
          <li>Create an OAuth app in your own {provider === "gmail" ? "Google Cloud" : "Microsoft Entra"} account.</li>
          <li>
            Add this redirect address: <code className="break-all text-foreground">{redirectUri}</code>
          </li>
          <li>
            Put its keys in <code className="text-foreground">.env</code> as <code className="text-foreground">{envNames}</code>, then restart Replyfold.
          </li>
        </ol>
      ) : null}
    </div>
  );
}

function ImapForm({ presets, onDone }: { presets: MailboxesResponse["presets"]; onDone: () => void }) {
  const [preset, setPreset] = useState<string>("custom");
  const [address, setAddress] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [imapHost, setImapHost] = useState("");
  const [imapPort, setImapPort] = useState("993");
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState("465");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const chosen = presets.find((item) => item.id === preset);

  function pick(id: string | null) {
    const next = presets.find((item) => item.id === id);
    setPreset(id ?? "custom");
    if (next) {
      setImapHost(next.imap.host);
      setImapPort(String(next.imap.port));
      setSmtpHost(next.smtp.host);
      setSmtpPort(String(next.smtp.port));
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/api/mailboxes/imap", {
        method: "POST",
        body: {
          address,
          displayName: displayName || address,
          username: username || address,
          password,
          imap: { host: imapHost, port: Number(imapPort), secure: Number(imapPort) === 993 },
          smtp: { host: smtpHost, port: Number(smtpPort), secure: Number(smtpPort) === 465 },
        },
      });
      toastManager.add({ title: "Mailbox connected", description: "The first sync reads the last 14 days of mail.", type: "success" });
      setPassword("");
      onDone();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not connect.");
    } finally {
      setBusy(false);
    }
  }

  const items = [{ value: "custom", label: "Another provider or my own domain" }, ...presets.map((item) => ({ value: item.id, label: item.label }))];

  return (
    <form onSubmit={submit} className="flex flex-col gap-4 rounded-lg border p-4">
      <div className="flex items-center gap-2.5">
        <ServerIcon className="size-4 text-muted-foreground" />
        <p className="flex-1 font-medium text-sm">Any other mailbox (IMAP and SMTP)</p>
      </div>
      <Field>
        <FieldLabel>Provider</FieldLabel>
        <Select value={preset} onValueChange={(value: string | null) => pick(value)} items={items}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {items.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        {chosen ? <FieldDescription>{chosen.passwordHelp}</FieldDescription> : <FieldDescription>Your provider's help pages list the IMAP and SMTP server names.</FieldDescription>}
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel>Email address</FieldLabel>
          <Input type="email" required value={address} onChange={(event) => setAddress(event.target.value)} placeholder="support@yourshop.com" />
        </Field>
        <Field>
          <FieldLabel>Sender name</FieldLabel>
          <Input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Your Shop Support" />
        </Field>
        <Field>
          <FieldLabel>Username</FieldLabel>
          <Input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="Usually the email address" />
        </Field>
        <Field>
          <FieldLabel>App password</FieldLabel>
          <Input type="password" required value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="off" />
        </Field>
      </div>
      <div className="grid grid-cols-[1fr_6rem] gap-x-3 gap-y-4 sm:grid-cols-[1fr_6rem_1fr_6rem]">
        <Field>
          <FieldLabel>IMAP server</FieldLabel>
          <Input required value={imapHost} onChange={(event) => setImapHost(event.target.value)} placeholder="imap.yourhost.com" />
        </Field>
        <Field>
          <FieldLabel>Port</FieldLabel>
          <Input required inputMode="numeric" value={imapPort} onChange={(event) => setImapPort(event.target.value)} />
        </Field>
        <Field>
          <FieldLabel>SMTP server</FieldLabel>
          <Input required value={smtpHost} onChange={(event) => setSmtpHost(event.target.value)} placeholder="smtp.yourhost.com" />
        </Field>
        <Field>
          <FieldLabel>Port</FieldLabel>
          <Input required inputMode="numeric" value={smtpPort} onChange={(event) => setSmtpPort(event.target.value)} />
        </Field>
      </div>
      {error ? <p className="text-destructive-foreground text-sm">{error}</p> : null}
      <div className="flex items-center gap-3">
        <Button type="submit" loading={busy}>
          Test and connect
        </Button>
        <p className="text-muted-foreground text-xs">Replyfold signs in to both servers first. The password is stored encrypted.</p>
      </div>
    </form>
  );
}

function Mailboxes() {
  const { user } = useSession();
  const data = useResource<MailboxesResponse>("/api/mailboxes");
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const canConnect = user.role !== "agent";

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const connected = params.get("connected");
    const error = params.get("error");
    if (connected) setNotice({ ok: true, text: `Connected ${connected}. The first sync reads the last 14 days of mail.` });
    if (error) setNotice({ ok: false, text: error });
    if (connected || error) history.replaceState(null, "", location.pathname);
  }, []);

  async function act(id: string, action: "sync" | "pause" | "resume" | "remove") {
    if (action === "sync") await api(`/api/mailboxes/${id}/sync`, { method: "POST", body: {} });
    if (action === "pause" || action === "resume") await api(`/api/mailboxes/${id}`, { method: "PATCH", body: { status: action === "pause" ? "paused" : "active" } });
    if (action === "remove") await api(`/api/mailboxes/${id}`, { method: "DELETE" });
    invalidate("/api/mailboxes", "/api/inbox");
  }

  if (!data.data) return null;
  const { mailboxes, oauth, redirectUris, presets } = data.data;

  return (
    <>
      {notice ? (
        <Alert variant={notice.ok ? "success" : "error"} className="mt-6">
          <AlertTitle>{notice.ok ? "Mailbox connected" : "The connection did not finish"}</AlertTitle>
          <AlertDescription>{notice.text}</AlertDescription>
        </Alert>
      ) : null}
      <Block title="Connected mailboxes" description="Replyfold checks each mailbox every minute and drafts a reply for every new customer email.">
        {mailboxes.length ? (
          <ul className="divide-y rounded-lg border">
            {mailboxes.map((mailbox) => (
              <li key={mailbox.id} className="flex items-center gap-3 px-4 py-3">
                <span className={cn("size-2 rounded-full", mailbox.status === "active" ? "bg-success" : mailbox.status === "paused" ? "bg-muted-foreground/50" : "bg-destructive")} />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-sm">
                    {mailbox.displayName} <span className="font-normal text-muted-foreground">{mailbox.address}</span>
                  </p>
                  <p className={cn("truncate text-xs", mailbox.status === "error" ? "text-destructive-foreground" : "text-muted-foreground")}>
                    {PROVIDER_LABELS[mailbox.provider]}.{" "}
                    {mailbox.status === "error" ? mailbox.lastError : mailbox.status === "paused" ? "Paused." : mailbox.lastSyncAt ? (relativeTime(mailbox.lastSyncAt) === "now" ? "Checked just now." : `Checked ${relativeTime(mailbox.lastSyncAt)} ago.`) : "Not checked yet."}
                  </p>
                </div>
                <Button size="icon-xs" variant="ghost" aria-label="Check now" title={mailbox.lastSyncAt ? `Last checked ${fullTime(mailbox.lastSyncAt)}` : "Check now"} onClick={() => void act(mailbox.id, "sync")}>
                  <RefreshCwIcon />
                </Button>
                {canConnect ? (
                  <Button size="icon-xs" variant="ghost" aria-label={mailbox.status === "paused" ? "Resume" : "Pause"} onClick={() => void act(mailbox.id, mailbox.status === "paused" ? "resume" : "pause")}>
                    {mailbox.status === "paused" ? <PlayIcon /> : <PauseIcon />}
                  </Button>
                ) : null}
                {user.role === "owner" ? (
                  <Button size="icon-xs" variant="ghost" aria-label="Disconnect" onClick={() => void act(mailbox.id, "remove")}>
                    <Trash2Icon />
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground text-sm">No mailbox yet. Connect one below.</p>
        )}
      </Block>
      <Block title="Connect a mailbox" description={canConnect ? "Use your own Google or Microsoft app, or an app password for any other provider. Replyfold talks to your mail provider directly." : "Ask an owner or lead to connect a mailbox."}>
        <div className="grid gap-3 lg:grid-cols-2">
          <OAuthOption
            provider="gmail"
            label="Gmail and Google Workspace"
            help="Reads and sends with the Gmail API. Replies stay in the same Gmail thread."
            configured={oauth.gmail}
            redirectUri={redirectUris.gmail}
            envNames="GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET"
            canConnect={canConnect}
          />
          <OAuthOption
            provider="microsoft"
            label="Microsoft 365 and Outlook.com"
            help="Reads and sends with Microsoft Graph. Works for work accounts and personal Outlook, Hotmail and Live addresses."
            configured={oauth.microsoft}
            redirectUri={redirectUris.microsoft}
            envNames="MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET"
            canConnect={canConnect}
          />
        </div>
        {canConnect ? (
          <div className="mt-3">
            <ImapForm presets={presets} onDone={() => invalidate("/api/mailboxes")} />
          </div>
        ) : null}
      </Block>
      <Block title="AI model" description="Pick the model that writes drafts, connect your ChatGPT plan or add an API key.">
        <Link href="/settings/ai" className="text-sm underline underline-offset-3">
          Open AI and classification settings
        </Link>
      </Block>
    </>
  );
}

function Team() {
  const { user } = useSession();
  const team = useResource<{ users: User[] }>("/api/team");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<string>("agent");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const owner = user.role === "owner";

  async function add(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    try {
      await api("/api/team", { method: "POST", body: { name, email, role, password } });
      setName("");
      setEmail("");
      setPassword("");
      invalidate("/api/team");
      toastManager.add({ title: `${name} can sign in now`, description: "Share the password with them in person or through a password manager.", type: "success" });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not add the teammate.");
    }
  }

  const roles = [
    { value: "agent", label: "Agent. Answers conversations." },
    { value: "lead", label: "Lead. Also edits the playbook and connects mailboxes." },
    { value: "owner", label: "Owner. Also manages the team." },
  ];

  return (
    <>
      <Block title="People" description="Everyone signs in with their own email and password.">
        <ul className="divide-y rounded-lg border">
          {(team.data?.users ?? []).map((member) => (
            <li key={member.id} className="flex items-center gap-3 px-4 py-2.5">
              <Person name={member.name} seed={member.id} size="md" />
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium text-sm">
                  {member.name} {member.id === user.id ? <span className="font-normal text-muted-foreground">(you)</span> : null}
                </p>
                <p className="truncate text-muted-foreground text-xs">{member.email}</p>
              </div>
              {owner && member.id !== user.id ? (
                <Select
                  value={member.role}
                  onValueChange={(value: string | null) => void api(`/api/team/${member.id}`, { method: "PATCH", body: { role: value } }).then(() => invalidate("/api/team"))}
                  items={roles.map((item) => ({ value: item.value, label: item.value[0]!.toUpperCase() + item.value.slice(1) }))}
                >
                  <SelectTrigger size="sm" className="w-28">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    {roles.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.value[0]!.toUpperCase() + item.value.slice(1)}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              ) : (
                <Badge variant="outline" className="capitalize">
                  {member.role}
                </Badge>
              )}
            </li>
          ))}
        </ul>
      </Block>
      {owner ? (
        <Block title="Add a teammate">
          <form onSubmit={add} className="grid max-w-2xl gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel>Name</FieldLabel>
              <Input required value={name} onChange={(event) => setName(event.target.value)} />
            </Field>
            <Field>
              <FieldLabel>Email</FieldLabel>
              <Input type="email" required value={email} onChange={(event) => setEmail(event.target.value)} />
            </Field>
            <Field>
              <FieldLabel>Role</FieldLabel>
              <Select value={role} onValueChange={(value: string | null) => setRole(value ?? "agent")} items={roles}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {roles.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </Field>
            <Field>
              <FieldLabel>First password</FieldLabel>
              <Input type="password" required minLength={10} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" />
              <FieldDescription>At least 10 characters. They can change it in their profile.</FieldDescription>
            </Field>
            {error ? <p className="text-destructive-foreground text-sm sm:col-span-2">{error}</p> : null}
            <div className="sm:col-span-2">
              <Button type="submit">Add teammate</Button>
            </div>
          </form>
        </Block>
      ) : null}
    </>
  );
}

function Profile() {
  const { user } = useSession();
  const [name, setName] = useState(user.name);
  const [signature, setSignature] = useState(user.signature);
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [mcp, setMcp] = useState(false);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      await api("/api/me", { method: "PUT", body: { name, signature, ...(password ? { password } : {}) } });
      setPassword("");
      invalidate("/api/session", "/api/team");
      toastManager.add({ title: "Profile saved", type: "success" });
    } catch (failure) {
      toastManager.add({ title: "Not saved", description: failure instanceof Error ? failure.message : undefined, type: "error" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save}>
      <Block title="You">
        <div className="grid max-w-xl gap-4">
          <Field>
            <FieldLabel>Name</FieldLabel>
            <Input required value={name} onChange={(event) => setName(event.target.value)} />
          </Field>
          <Field>
            <FieldLabel>Signature</FieldLabel>
            <Textarea value={signature} onChange={(event) => setSignature(event.target.value)} rows={3} placeholder={"Morgan\nYour Shop Support"} />
            <FieldDescription>Added under every reply you send.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel>New password</FieldLabel>
            <Input type="password" minLength={10} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" placeholder="Leave empty to keep the current one" />
          </Field>
          <div>
            <Button type="submit" loading={saving}>
              Save profile
            </Button>
          </div>
        </div>
      </Block>
      <Block title="Agents and the MCP endpoint" description="Coding agents can read the inbox, drafts and statistics through a read-only MCP endpoint at /mcp.">
        <label className="flex max-w-xl items-center justify-between gap-4 text-sm">
          Show how to turn it on
          <Switch checked={mcp} onCheckedChange={setMcp} />
        </label>
        {mcp ? (
          <ol className="mt-3 list-decimal space-y-1 pl-4 text-muted-foreground text-sm">
            <li>
              Set <code className="text-foreground">MCP_TOKEN</code> in <code className="text-foreground">.env</code> to a long random string, then restart.
            </li>
            <li>
              Point the agent at <code className="text-foreground">{location.origin}/mcp</code> with the header <code className="text-foreground">Authorization: Bearer</code> and the token.
            </li>
          </ol>
        ) : null}
      </Block>
    </form>
  );
}

export function Settings({ section }: { section: "mailboxes" | "ai" | "team" | "profile" }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader title="Settings" />
      <div className="flex min-h-0 flex-1">
        <nav className="hidden w-52 shrink-0 flex-col gap-px border-r p-3 md:flex" aria-label="Settings">
          {SECTIONS.map((item) => (
            <Link
              key={item.id}
              href={`/settings/${item.id}`}
              aria-current={section === item.id ? "page" : undefined}
              className={cn("rounded-md px-2 py-1.5 text-sm text-foreground/72 hover:bg-foreground/[0.045] hover:text-foreground", section === item.id && "bg-foreground/[0.06] font-medium text-foreground")}
            >
              {item.label}
            </Link>
          ))}
          <p className="mt-auto px-2 pt-4 text-muted-foreground text-xs">
            Replyfold is built by{" "}
            <a href="https://cyndra.ai" target="_blank" rel="noreferrer" className="underline underline-offset-3 hover:text-foreground">
              Cyndra
            </a>
            .
          </p>
        </nav>
        <div className="min-w-0 flex-1 overflow-y-auto px-8 pb-10 max-md:px-4">
          <nav className="-mx-4 flex gap-1 overflow-x-auto border-b px-4 py-2 md:hidden" aria-label="Settings sections">
            {SECTIONS.map((item) => (
              <Link
                key={item.id}
                href={`/settings/${item.id}`}
                aria-current={section === item.id ? "page" : undefined}
                className={cn("shrink-0 rounded-md px-2.5 py-1.5 text-sm text-foreground/72", section === item.id && "bg-foreground/[0.06] font-medium text-foreground")}
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="max-w-4xl">
            {section === "mailboxes" ? <Mailboxes /> : null}
            {section === "ai" ? <AiSettingsSection /> : null}
            {section === "team" ? <Team /> : null}
            {section === "profile" ? <Profile /> : null}
          </div>
        </div>
      </div>
    </div>
  );
}
