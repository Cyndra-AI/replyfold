import { CheckCircle2Icon, ChevronDownIcon, CircleAlertIcon, ExternalLinkIcon, KeyRoundIcon, SparklesIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { api, type AiProviderView, type AiResponse, type ModelChoice } from "../lib/api";
import { CATEGORY_LABELS, relativeTime } from "../lib/format";
import { invalidate, useResource } from "../lib/resource";
import { cn } from "../lib/utils";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPopup, DialogTitle } from "../ui/dialog";
import { Field, FieldDescription, FieldLabel } from "../ui/field";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { useSession } from "./App";
import { MoodBadge } from "./common";

const PATH = "/api/ai";

function Block({ id, title, description, children }: { id?: string; title: string; description?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-6 border-b py-6 last:border-b-0">
      <h2 className="font-medium text-sm">{title}</h2>
      {description ? <p className="mt-1 max-w-[65ch] text-muted-foreground text-sm">{description}</p> : null}
      <div className="mt-4">{children}</div>
    </section>
  );
}

const errorText = (failure: unknown) => (failure instanceof Error ? failure.message : "Something went wrong.");

function UsageLink({ url }: { url: string }) {
  return (
    <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-foreground underline underline-offset-3">
      Manage usage
      <ExternalLinkIcon className="size-3" />
    </a>
  );
}

function providerLabel(data: AiResponse, kind: string) {
  return kind === "chatgpt" ? "ChatGPT plan" : (data.providers.find((provider) => provider.kind === kind)?.label ?? kind);
}

/** Picks the provider and model that write drafts. The model list comes live from the provider. */
function ActiveModel({ data, owner }: { data: AiResponse; owner: boolean }) {
  const choices = [
    ...(data.chatgpt.connected && data.chatgpt.planEnabled ? [{ value: "chatgpt", label: "ChatGPT plan" }] : []),
    ...data.providers.filter((provider) => provider.connected).map((provider) => ({ value: provider.kind, label: provider.label })),
  ];
  const [kind, setKind] = useState(data.active?.kind ?? choices[0]?.value ?? "");
  const [model, setModel] = useState(data.active?.model ?? "");
  const [models, setModels] = useState<ModelChoice[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!kind || !owner) return;
    let live = true;
    setModels(null);
    setLoadError("");
    api<{ models: ModelChoice[] }>(`/api/ai/models/${kind}`)
      .then((result) => {
        if (!live) return;
        setModels(result.models);
        setModel((current) => (result.models.some((item) => item.id === current) ? current : (result.models[0]?.id ?? "")));
      })
      .catch((failure) => live && setLoadError(errorText(failure)));
    return () => {
      live = false;
    };
  }, [kind, owner]);

  async function save() {
    setSaving(true);
    setError("");
    try {
      await api(PATH.concat("/active"), { method: "PUT", body: { kind, model } });
      invalidate(PATH);
    } catch (failure) {
      setError(errorText(failure));
      invalidate(PATH);
    } finally {
      setSaving(false);
    }
  }

  const current = data.active;
  return (
    <Block title="Model for drafts" description="Replyfold writes every draft with this model. Each provider bills your own account.">
      <div className="flex flex-col gap-4 rounded-lg border p-4">
        <div className="flex items-start gap-2 text-sm">
          {current || data.env ? <CheckCircle2Icon className="mt-0.5 size-4 shrink-0 text-success" /> : <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-warning-foreground" />}
          <p className="min-w-0 flex-1">
            {current ? (
              <>
                Drafts use <span className="font-medium">{current.model}</span> <span className="text-muted-foreground">from {providerLabel(data, current.kind)}.</span>
                {current.kind === "chatgpt" ? (
                  <span className="ms-2 inline-flex items-center gap-2 align-middle">
                    <Badge variant="info" size="sm">
                      Using ChatGPT plan
                    </Badge>
                    <UsageLink url={data.chatgpt.usageUrl} />
                  </span>
                ) : null}
              </>
            ) : data.env ? (
              <>
                Drafts use <span className="font-medium">{data.env.name}</span> <span className="text-muted-foreground">from the server's .env file. Pick a provider below to switch.</span>
              </>
            ) : (
              "No model yet. Connect ChatGPT or add an API key below, then pick a model here."
            )}
          </p>
        </div>
        {owner && choices.length ? (
          <div className="grid gap-3 sm:grid-cols-[12rem_1fr_auto] sm:items-end">
            <Field>
              <FieldLabel>Provider</FieldLabel>
              <Select value={kind} onValueChange={(value: string | null) => setKind(value ?? "")} items={choices}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {choices.map((choice) => (
                    <SelectItem key={choice.value} value={choice.value}>
                      {choice.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </Field>
            <Field>
              <FieldLabel>Model</FieldLabel>
              {models ? (
                <Select value={model} onValueChange={(value: string | null) => setModel(value ?? "")} items={models.map((item) => ({ value: item.id, label: item.label }))}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    {models.map((item) => (
                      <SelectItem key={item.id} value={item.id}>
                        {item.label}
                        {item.label !== item.id ? <span className="text-muted-foreground text-xs">{item.id}</span> : null}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              ) : loadError ? (
                <p className="text-destructive-foreground text-sm">{loadError}</p>
              ) : (
                <p className="flex h-9 items-center gap-2 text-muted-foreground text-sm">
                  <Spinner className="size-3.5" /> Reading the provider's model list
                </p>
              )}
            </Field>
            <Button onClick={() => void save()} loading={saving} disabled={!model || (current?.kind === kind && current.model === model)}>
              Use this model
            </Button>
          </div>
        ) : null}
        {error ? <p className="text-destructive-foreground text-sm">{error}</p> : null}
      </div>
    </Block>
  );
}

function ChatGPTMark() {
  // A neutral spark mark. Replyfold does not ship OpenAI's logo files.
  return <SparklesIcon className="size-4" />;
}

function ChatGPTCard({ data, owner }: { data: AiResponse; owner: boolean }) {
  const { chatgpt } = data;
  const [busy, setBusy] = useState(false);
  // A link cannot be disabled, so the sign-in links become plain disabled buttons away from 127.0.0.1.
  const startLink = (href: string) => (chatgpt.canStartHere ? { render: <a href={href} /> } : { disabled: true });

  async function signOut() {
    setBusy(true);
    try {
      const result = await api<{ revoked: boolean }>("/api/ai/chatgpt/signout", { method: "POST", body: {} });
      toastManager.add(
        result.revoked
          ? { title: "Signed out of ChatGPT", type: "success" }
          : { title: "Signed out here", description: "OpenAI did not confirm the sign-out. You can also disconnect Replyfold in ChatGPT settings.", type: "warning" },
      );
      invalidate(PATH);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Block
      title="Use your ChatGPT plan"
      description="Complete eligible draft requests with the usage included in your ChatGPT Plus or Pro plan. It is separate from any API key, and Replyfold itself costs nothing."
    >
      <div className="flex flex-col gap-3 rounded-lg border p-4">
        {chatgpt.connected ? (
          <>
            <div className="flex flex-wrap items-center gap-2.5">
              <ChatGPTMark />
              <p className="flex-1 text-sm">
                Signed in as <span className="font-medium">{chatgpt.email || "your ChatGPT account"}</span>
              </p>
              {chatgpt.planEnabled ? <Badge variant="success" size="sm">Plan use on</Badge> : <Badge variant="warning" size="sm">Plan use off</Badge>}
            </div>
            {chatgpt.planEnabled ? (
              <p className="text-muted-foreground text-xs leading-relaxed">
                Drafts count toward your plan's usage when you pick the ChatGPT plan above. Set a weekly limit for Replyfold in ChatGPT settings. <UsageLink url={chatgpt.usageUrl} />
              </p>
            ) : (
              <p className="text-muted-foreground text-xs leading-relaxed">You signed in without allowing plan use, so Replyfold cannot write drafts with ChatGPT. Turn it on, or add an API key below.</p>
            )}
            {owner ? (
              <div className="flex flex-wrap gap-2">
                {!chatgpt.planEnabled ? (
                  <Button size="sm" {...startLink("/api/ai/chatgpt/start?consent=1")}>
                    Turn on plan use
                  </Button>
                ) : null}
                <Button size="sm" variant="outline" {...startLink("/api/ai/chatgpt/start?account=new")}>
                  Use another account
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void signOut()} loading={busy}>
                  Sign out
                </Button>
              </div>
            ) : null}
          </>
        ) : owner ? (
          <div className="flex flex-col gap-3">
            <div>
              <Button
                className="border-black bg-black text-white hover:bg-black/85 dark:border-white dark:bg-white dark:text-black dark:hover:bg-white/85"
                {...startLink("/api/ai/chatgpt/start")}
              >
                <ChatGPTMark />
                Continue with ChatGPT
              </Button>
            </div>
            {chatgpt.canStartHere ? (
              <p className="text-muted-foreground text-xs leading-relaxed">OpenAI opens in this browser. You name the app, approve plan use, and come back here.</p>
            ) : (
              <p className="max-w-[65ch] text-muted-foreground text-xs leading-relaxed">
                OpenAI only returns the sign-in to the computer that runs Replyfold. Open <code className="text-foreground">{chatgpt.loopbackUrl}</code> on that computer and press the button there. On a remote server, forward the port first with{" "}
                <code className="text-foreground">ssh -L {new URL(chatgpt.loopbackUrl).port}:127.0.0.1:{new URL(chatgpt.loopbackUrl).port} your-server</code>.
              </p>
            )}
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">Not connected. Ask an owner to connect ChatGPT.</p>
        )}
      </div>
    </Block>
  );
}

function KeyRow({ provider, owner, open, onToggle }: { provider: AiProviderView; owner: boolean; open: boolean; onToggle: () => void }) {
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(provider.needsBaseUrl ? provider.baseUrl : "");
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const changed = Boolean(apiKey) || (provider.needsBaseUrl && baseUrl !== provider.baseUrl);
  const canSubmit = changed || provider.connected;

  async function test() {
    setTesting(true);
    setResult(null);
    try {
      setResult(await api<{ ok: boolean; message: string }>(`/api/ai/providers/${provider.kind}/test`, { method: "POST", body: { apiKey: apiKey || undefined, baseUrl: provider.needsBaseUrl ? baseUrl : undefined } }));
      invalidate(PATH);
    } catch (failure) {
      setResult({ ok: false, message: errorText(failure) });
    } finally {
      setTesting(false);
    }
  }

  async function save() {
    setSaving(true);
    setResult(null);
    try {
      await api(`/api/ai/providers/${provider.kind}`, { method: "PUT", body: { apiKey: apiKey || undefined, baseUrl: provider.needsBaseUrl ? baseUrl : undefined } });
      setApiKey("");
      const tested = await api<{ ok: boolean; message: string }>(`/api/ai/providers/${provider.kind}/test`, { method: "POST", body: {} });
      setResult(tested);
      invalidate(PATH);
    } catch (failure) {
      setResult({ ok: false, message: errorText(failure) });
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    await api(`/api/ai/providers/${provider.kind}`, { method: "DELETE" });
    setResult(null);
    invalidate(PATH);
  }

  return (
    <li id={`key-${provider.kind}`} className="scroll-mt-6">
      <button type="button" onClick={onToggle} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-foreground/[0.025]" aria-expanded={open}>
        <span className={cn("size-2 rounded-full", provider.connected ? (provider.test?.ok === false ? "bg-destructive" : "bg-success") : "bg-muted-foreground/30")} />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium text-sm">{provider.label}</span>
          <span className="block truncate text-muted-foreground text-xs">
            {provider.connected
              ? [provider.keyHint ? `Key ${provider.keyHint}` : "No key", provider.needsBaseUrl ? provider.baseUrl : "", provider.test ? `${provider.test.ok ? "Worked" : "Failed"} ${relativeTime(provider.test.at) === "now" ? "just now" : `${relativeTime(provider.test.at)} ago`}` : "Not tested"]
                  .filter(Boolean)
                  .join(". ")
              : "Not connected"}
          </span>
        </span>
        <ChevronDownIcon className={cn("size-4 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>
      {open ? (
        <div className="flex flex-col gap-4 border-t bg-foreground/[0.015] px-4 py-4">
          {owner ? (
            <>
              <div className={cn("grid gap-4", provider.needsBaseUrl && "sm:grid-cols-2")}>
                {provider.needsBaseUrl ? (
                  <Field>
                    <FieldLabel>Base URL</FieldLabel>
                    <Input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="http://localhost:11434/v1" />
                    <FieldDescription>Any server with the OpenAI chat completions API: Ollama, vLLM, LM Studio, Together and others.</FieldDescription>
                  </Field>
                ) : null}
                <Field>
                  <FieldLabel>API key{provider.keyOptional ? " (optional)" : ""}</FieldLabel>
                  <Input
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    placeholder={provider.keyHint ? `Saved key ${provider.keyHint}. Paste a new one to replace it.` : "Paste the key"}
                  />
                  <FieldDescription>
                    Stored encrypted on this server. Nobody sees it again, including you.{" "}
                    {provider.keyUrl ? (
                      <a href={provider.keyUrl} target="_blank" rel="noreferrer" className="text-foreground underline underline-offset-3">
                        Create a {provider.label} key
                      </a>
                    ) : null}
                  </FieldDescription>
                </Field>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" onClick={() => void save()} loading={saving} disabled={!changed}>
                  Save
                </Button>
                <Button size="sm" variant="outline" onClick={() => void test()} loading={testing} disabled={!canSubmit}>
                  Test connection
                </Button>
                {provider.connected ? (
                  <Button size="sm" variant="ghost" onClick={() => void remove()}>
                    Remove
                  </Button>
                ) : null}
                {result ? (
                  <p className={cn("flex items-center gap-1.5 text-sm", result.ok ? "text-success-foreground" : "text-destructive-foreground")} role="status">
                    {result.ok ? <CheckCircle2Icon className="size-4" /> : <CircleAlertIcon className="size-4" />}
                    {result.message}
                  </p>
                ) : provider.test && !provider.test.ok ? (
                  <p className="text-destructive-foreground text-sm">{provider.test.message}</p>
                ) : null}
              </div>
            </>
          ) : (
            <p className="text-muted-foreground text-sm">Only an owner can change API keys.</p>
          )}
        </div>
      ) : null}
    </li>
  );
}

function ApiKeys({ data, owner, open, setOpen }: { data: AiResponse; owner: boolean; open: string; setOpen: (kind: string) => void }) {
  return (
    <Block id="keys" title="Bring your own key" description="Add a key from any of these providers. Replyfold reads each provider's live model list with your key, so new models show up without an update.">
      <ul className="divide-y rounded-lg border">
        {data.providers.map((provider) => (
          <KeyRow key={provider.kind} provider={provider} owner={owner} open={open === provider.kind} onToggle={() => setOpen(open === provider.kind ? "" : provider.kind)} />
        ))}
      </ul>
    </Block>
  );
}

const SAMPLE = {
  subject: "Order #1042 still not here",
  text: "I ordered a mug set two weeks ago and tracking has not moved in six days. It is a birthday present for Saturday. This is the second time I am writing. Can someone please tell me what is going on?",
};

function Classification({ data, owner, openKey }: { data: AiResponse; owner: boolean; openKey: () => void }) {
  const { classification } = data;
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ category: string; mood: string; model: string; ms: number } | null>(null);
  const [error, setError] = useState("");

  async function toggle(jev: boolean) {
    setBusy(true);
    setError("");
    try {
      await api(`${PATH}/classification`, { method: "PUT", body: { jev } });
      setResult(null);
      invalidate(PATH);
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setTesting(true);
    setError("");
    setResult(null);
    try {
      setResult(await api(`${PATH}/classification/test`, { method: "POST", body: SAMPLE }));
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setTesting(false);
    }
  }

  const plan = classification.plan;
  return (
    <Block
      id="classification"
      title="Classification"
      description="Before each draft, Replyfold tags the email with a case type and the customer's mood. The inbox shows the mood, you can filter by it, and the draft matches its tone. If tagging fails, the draft is written anyway."
    >
      <div className="flex flex-col divide-y rounded-lg border">
        <div className="flex items-start gap-4 p-4">
          <div className="min-w-0 flex-1">
            <p className="font-medium text-sm">Use Jev for classification</p>
            <p className="mt-0.5 text-muted-foreground text-xs leading-relaxed">
              Jev is TypeSafe's decision model on OpenRouter. It returns a fixed label instead of free text, which makes it fast and very cheap for tagging.
            </p>
            {!classification.openrouterConnected ? (
              <button type="button" onClick={openKey} className="mt-2 text-foreground text-xs underline underline-offset-3">
                Add an OpenRouter key to use Jev
              </button>
            ) : null}
          </div>
          <Switch
            checked={classification.jev && classification.openrouterConnected}
            disabled={!owner || !classification.openrouterConnected || busy}
            onCheckedChange={(checked: boolean) => void toggle(checked)}
            aria-label="Use Jev for classification"
          />
        </div>
        <div className="flex flex-col gap-3 p-4">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
            <span className="text-muted-foreground">Model in use now:</span>
            {plan.kind === "none" ? (
              <span className="font-medium">None</span>
            ) : (
              <>
                <span className="font-medium">{plan.name}</span>
                <span className="text-muted-foreground">through {plan.provider}</span>
              </>
            )}
          </div>
          <p className="text-muted-foreground text-xs">{plan.note}</p>
          {owner ? (
            <div className="flex flex-wrap items-center gap-3">
              <Button size="sm" variant="outline" onClick={() => void test()} loading={testing} disabled={plan.kind === "none"}>
                Test classification
              </Button>
              {result ? (
                <p className="flex flex-wrap items-center gap-2 text-sm" role="status">
                  <CheckCircle2Icon className="size-4 text-success" />
                  <Badge variant="outline" size="sm">
                    {CATEGORY_LABELS[result.category] ?? result.category}
                  </Badge>
                  <MoodBadge mood={result.mood} />
                  <span className="text-muted-foreground text-xs">
                    {result.model}, {(result.ms / 1000).toFixed(1)} s
                  </span>
                </p>
              ) : null}
            </div>
          ) : null}
          {owner ? <p className="text-muted-foreground text-xs">The test sends one made-up email: "{SAMPLE.text.slice(0, 72)}…"</p> : null}
          {error ? <p className="text-destructive-foreground text-sm">{error}</p> : null}
        </div>
      </div>
    </Block>
  );
}

function WelcomeDialog({ open, usageUrl }: { open: boolean; usageUrl: string }) {
  const [dismissed, setDismissed] = useState(false);
  const close = () => {
    setDismissed(true);
    void api(`${PATH}/chatgpt/welcomed`, { method: "POST", body: {} }).then(() => invalidate(PATH));
  };
  return (
    <Dialog open={open && !dismissed} onOpenChange={(next: boolean) => (next ? undefined : close())}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>You're using your ChatGPT plan</DialogTitle>
          <DialogDescription>
            Eligible AI requests in Replyfold now use your ChatGPT plan when you pick it as the model for drafts. You can review usage and set a limit for Replyfold in{" "}
            <a href={usageUrl} target="_blank" rel="noreferrer" className="text-foreground underline underline-offset-3">
              ChatGPT settings
            </a>
            .
          </DialogDescription>
        </DialogHeader>
        <DialogFooter variant="bare">
          <Button onClick={close}>Got it</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function AiSettingsSection() {
  const { user } = useSession();
  const owner = user.role === "owner";
  const data = useResource<AiResponse>(PATH);
  const [notice, setNotice] = useState<{ ok: boolean; title: string; text: string } | null>(null);
  const [openKey, setOpenKey] = useState("");

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const chatgpt = params.get("chatgpt");
    const error = params.get("error");
    if (chatgpt === "connected") setNotice({ ok: true, title: "ChatGPT connected", text: "Pick the ChatGPT plan under Model for drafts to use it." });
    if (chatgpt === "no-plan") setNotice({ ok: false, title: "Signed in without plan use", text: "ChatGPT did not allow plan use. Turn it on below, or add an API key." });
    if (error) setNotice({ ok: false, title: "The connection did not finish", text: error });
    if (chatgpt || error) history.replaceState(null, "", location.pathname);
  }, []);

  if (!data.data) return null;
  const view = data.data;
  const showKey = (kind: string) => {
    setOpenKey(kind);
    requestAnimationFrame(() => document.getElementById(`key-${kind}`)?.scrollIntoView({ behavior: "smooth", block: "center" }));
  };

  return (
    <>
      {notice ? (
        <Alert variant={notice.ok ? "success" : "error"} className="mt-6">
          <AlertTitle>{notice.title}</AlertTitle>
          <AlertDescription>{notice.text}</AlertDescription>
        </Alert>
      ) : null}
      {!owner ? (
        <Alert variant="info" className="mt-6">
          <KeyRoundIcon />
          <AlertDescription>Only an owner can change the AI provider, keys and classification.</AlertDescription>
        </Alert>
      ) : null}
      <ActiveModel key={`${view.active?.kind}:${view.active?.model}:${view.providers.filter((item) => item.connected).length}:${view.chatgpt.planEnabled}`} data={view} owner={owner} />
      <ChatGPTCard data={view} owner={owner} />
      <ApiKeys data={view} owner={owner} open={openKey} setOpen={setOpenKey} />
      <Classification data={view} owner={owner} openKey={() => showKey("openrouter")} />
      <WelcomeDialog open={view.chatgpt.welcomePending && owner} usageUrl={view.chatgpt.usageUrl} />
    </>
  );
}
