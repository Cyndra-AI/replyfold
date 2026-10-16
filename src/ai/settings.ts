import { z } from "zod";
import type { SecretBox } from "../core/secrets";
import type { Store } from "../db/store";
import { ChatGPTAuth, CHATGPT, type ChatGPTAccount, type ChatGPTSession } from "./chatgpt";
import { findJevModel, JevClassifier, ModelClassifier, pickSmallModel, type Classifier, type JevModel } from "./classifier";
import { ModelError, type Fetch, type ModelProvider } from "./model";
import {
  ChatGPTPlanModel,
  createKeyModel,
  KEY_PROVIDERS,
  listChatGPTModels,
  listKeyModels,
  maskKey,
  PROVIDER_SPECS,
  type AiProviderKind,
  type KeyCredentials,
  type KeyProviderKind,
  type ModelChoice,
} from "./providers";

const KEY = (kind: AiProviderKind) => `ai.key.${kind}`;
const META = (kind: KeyProviderKind) => `ai.meta.${kind}`;
const MODELS = (kind: AiProviderKind) => `ai.models.${kind}`;
const ACTIVE = "ai.active";
const CLASSIFY = "ai.classify";
const CHATGPT_HOST = "ai.chatgpt.host";
const CHATGPT_ACCOUNT = "ai.chatgpt.account";
const CHATGPT_WELCOMED = "ai.chatgpt.welcomed";

const Credentials = z.object({ apiKey: z.string(), baseUrl: z.string().optional() });
const Meta = z.object({
  keyHint: z.string(),
  baseUrl: z.string().optional(),
  savedAt: z.string(),
  test: z.object({ ok: z.boolean(), at: z.string(), message: z.string() }).nullable().default(null),
});
const Active = z.object({ kind: z.enum([...KEY_PROVIDERS, "chatgpt"]), model: z.string().min(1) });
const ClassifySettings = z.object({ jev: z.boolean().default(false), model: z.string().nullable().default(null) });
const ModelCache = z.object({ at: z.number(), models: z.array(z.object({ id: z.string(), label: z.string() })) });

export type ProviderView = {
  kind: KeyProviderKind;
  label: string;
  keyUrl: string;
  keyOptional: boolean;
  needsBaseUrl: boolean;
  connected: boolean;
  keyHint: string;
  baseUrl: string;
  test: { ok: boolean; at: string; message: string } | null;
};

export type ClassifierPlan = { kind: "jev" | "model" | "none"; name: string; provider: string; note: string };

const MODEL_CACHE_MS = 6 * 3_600_000;

/** Stores AI provider keys (sealed with the server key), the active model, and the ChatGPT sign-in. */
export class AiSettings {
  readonly chatgpt: ChatGPTAuth;
  private jev: { at: number; model: JevModel | null } | null = null;

  constructor(
    private readonly store: Store,
    private readonly box: SecretBox,
    private readonly fetcher: Fetch = fetch,
    private readonly clock: () => number = Date.now,
  ) {
    this.chatgpt = new ChatGPTAuth(
      {
        hostId: () => {
          const existing = this.store.setting(CHATGPT_HOST);
          if (existing) return existing;
          const created = `urn:uuid:${crypto.randomUUID()}`;
          this.store.setSetting(CHATGPT_HOST, created);
          return created;
        },
        session: () => this.chatgptSession(),
        saveSession: (session: ChatGPTSession | null) => {
          if (session) this.store.setSetting(KEY("chatgpt"), this.box.seal(session));
          else this.store.deleteSetting(KEY("chatgpt"));
        },
        account: () => this.readJson(CHATGPT_ACCOUNT, z.object({ clientId: z.string(), subject: z.string(), email: z.string() })),
        saveAccount: (account: ChatGPTAccount) => this.store.setSetting(CHATGPT_ACCOUNT, JSON.stringify(account)),
      },
      fetcher,
      clock,
    );
  }

  private readJson<T>(key: string, schema: z.ZodType<T>): T | null {
    const raw = this.store.setting(key);
    if (!raw) return null;
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  }

  private chatgptSession(): ChatGPTSession | null {
    const sealed = this.store.setting(KEY("chatgpt"));
    return sealed ? (this.box.open(sealed) as ChatGPTSession) : null;
  }

  credentials(kind: KeyProviderKind): KeyCredentials | null {
    const sealed = this.store.setting(KEY(kind));
    return sealed ? Credentials.parse(this.box.open(sealed)) : null;
  }

  /** Saves a key. An empty key keeps the stored one, so the user can change only the base URL. */
  saveKey(kind: KeyProviderKind, input: { apiKey?: string; baseUrl?: string }) {
    const current = this.credentials(kind);
    const apiKey = input.apiKey?.trim() || current?.apiKey || "";
    const spec = PROVIDER_SPECS[kind];
    if (!apiKey && !spec.keyOptional) throw new ModelError(`Paste your ${spec.label} API key.`);
    const baseUrl = kind === "custom" ? (input.baseUrl?.trim() || current?.baseUrl || "").replace(/\/$/, "") : undefined;
    if (kind === "custom" && !baseUrl) throw new ModelError("Add the server's base URL, for example http://localhost:11434/v1.");
    this.store.setSetting(KEY(kind), this.box.seal({ apiKey, ...(baseUrl ? { baseUrl } : {}) }));
    const meta: z.infer<typeof Meta> = { keyHint: maskKey(apiKey), ...(baseUrl ? { baseUrl } : {}), savedAt: new Date(this.clock()).toISOString(), test: null };
    this.store.setSetting(META(kind), JSON.stringify(meta));
    this.store.deleteSetting(MODELS(kind));
  }

  removeKey(kind: KeyProviderKind) {
    for (const key of [KEY(kind), META(kind), MODELS(kind)]) this.store.deleteSetting(key);
    if (this.active()?.kind === kind) this.store.deleteSetting(ACTIVE);
    if (kind === "openrouter" && this.classifySettings().jev) this.store.setSetting(CLASSIFY, JSON.stringify({ ...this.classifySettings(), jev: false }));
  }

  /** Reads the live model list with the given key, or the stored key when none is given. Records the outcome. */
  async test(kind: KeyProviderKind, input: { apiKey?: string; baseUrl?: string } = {}) {
    const stored = this.credentials(kind);
    const credentials: KeyCredentials = { apiKey: input.apiKey?.trim() || stored?.apiKey || "", baseUrl: input.baseUrl?.trim() || stored?.baseUrl };
    if (!credentials.apiKey && !PROVIDER_SPECS[kind].keyOptional) throw new ModelError(`Paste your ${PROVIDER_SPECS[kind].label} API key first.`);
    const at = new Date(this.clock()).toISOString();
    try {
      const models = await listKeyModels(kind, credentials, this.fetcher);
      const message = `Connected. ${models.length} model${models.length === 1 ? "" : "s"} available.`;
      this.recordTest(kind, credentials, { ok: true, at, message }, models);
      return { ok: true as const, message, models };
    } catch (error) {
      const message = error instanceof Error ? error.message : "The connection failed.";
      this.recordTest(kind, credentials, { ok: false, at, message }, null);
      return { ok: false as const, message, models: [] };
    }
  }

  private recordTest(kind: KeyProviderKind, credentials: KeyCredentials, test: { ok: boolean; at: string; message: string }, models: ModelChoice[] | null) {
    const stored = this.credentials(kind);
    if (!stored || stored.apiKey !== credentials.apiKey || stored.baseUrl !== credentials.baseUrl) return;
    const meta = this.readJson(META(kind), Meta);
    if (meta) this.store.setSetting(META(kind), JSON.stringify({ ...meta, test }));
    if (models) this.store.setSetting(MODELS(kind), JSON.stringify({ at: this.clock(), models }));
  }

  async models(kind: AiProviderKind, fresh = false): Promise<ModelChoice[]> {
    const cached = this.readJson(MODELS(kind), ModelCache);
    if (!fresh && cached && this.clock() - cached.at < MODEL_CACHE_MS) return cached.models;
    let models: ModelChoice[];
    if (kind === "chatgpt") {
      models = await listChatGPTModels(await this.chatgpt.accessToken(), this.fetcher);
    } else {
      const credentials = this.credentials(kind);
      if (!credentials) throw new ModelError(`Add a ${PROVIDER_SPECS[kind].label} key first.`);
      models = await listKeyModels(kind, credentials, this.fetcher);
    }
    this.store.setSetting(MODELS(kind), JSON.stringify({ at: this.clock(), models }));
    return models;
  }

  connected(kind: AiProviderKind) {
    return kind === "chatgpt" ? Boolean(this.chatgptSession()) : Boolean(this.store.setting(KEY(kind)));
  }

  active() {
    return this.readJson(ACTIVE, Active);
  }

  setActive(selection: { kind: AiProviderKind; model: string }) {
    if (!this.connected(selection.kind)) throw new ModelError("Connect this provider before choosing it.");
    this.store.setSetting(ACTIVE, JSON.stringify(Active.parse(selection)));
  }

  clearActive() {
    this.store.deleteSetting(ACTIVE);
  }

  /** The model for drafts, or null when nothing is chosen in Settings. */
  activeModel(): ModelProvider | null {
    const active = this.active();
    if (!active) return null;
    return this.modelFor(active.kind, active.model);
  }

  modelFor(kind: AiProviderKind, model: string): ModelProvider | null {
    if (kind === "chatgpt") return this.chatgptSession() ? new ChatGPTPlanModel({ accessToken: () => this.chatgpt.accessToken(), model }, this.fetcher) : null;
    const credentials = this.credentials(kind);
    return credentials ? createKeyModel(kind, credentials, model, this.fetcher) : null;
  }

  classifySettings() {
    return this.readJson(CLASSIFY, ClassifySettings) ?? { jev: false, model: null };
  }

  saveClassifySettings(input: { jev?: boolean; model?: string | null }) {
    const next = { ...this.classifySettings(), ...input };
    if (next.jev && !this.connected("openrouter")) throw new ModelError("Add an OpenRouter key to use Jev.");
    this.store.setSetting(CLASSIFY, JSON.stringify(next));
  }

  async jevModel(): Promise<JevModel | null> {
    if (this.jev && this.clock() - this.jev.at < MODEL_CACHE_MS) return this.jev.model;
    const model = await findJevModel(this.fetcher).catch(() => null);
    this.jev = { at: this.clock(), model };
    return model;
  }

  /**
   * Chooses the classifier, in this order:
   * 1. Jev through the OpenRouter key, when the key exists and Jev is on.
   * 2. A small model of the selected provider, read from its live model list. The selected model if none looks small.
   * 3. The model set in .env, if any. Otherwise none, and drafts still run without a mood tag.
   */
  async classifier(fallback: ModelProvider | null): Promise<{ classifier: Classifier | null; plan: ClassifierPlan }> {
    const settings = this.classifySettings();
    const openrouter = settings.jev ? this.credentials("openrouter") : null;
    if (openrouter) {
      const jev = await this.jevModel();
      if (jev) {
        const note = jev.inputPricePerMillion === null ? "Billed to your OpenRouter account." : `Billed to your OpenRouter account at $${jev.inputPricePerMillion.toFixed(3)} per million input tokens, with no output charge.`;
        return { classifier: new JevClassifier({ apiKey: openrouter.apiKey, model: jev.id }, this.fetcher), plan: { kind: "jev", name: jev.label, provider: "OpenRouter", note } };
      }
    }
    const active = this.active();
    if (active) {
      const label = active.kind === "chatgpt" ? "ChatGPT plan" : PROVIDER_SPECS[active.kind].label;
      let chosen = settings.model ?? null;
      if (!chosen) {
        const models = await this.models(active.kind).catch(() => [] as ModelChoice[]);
        chosen = pickSmallModel(models)?.id ?? active.model;
      }
      const model = this.modelFor(active.kind, chosen);
      if (model) {
        const note = active.kind === "chatgpt" ? "Counts toward your ChatGPT plan usage." : `Billed to your ${label} account. A small model costs a fraction of a cent per email.`;
        return { classifier: new ModelClassifier(model), plan: { kind: "model", name: chosen, provider: label, note } };
      }
    }
    if (fallback) {
      return { classifier: new ModelClassifier(fallback), plan: { kind: "model", name: fallback.name, provider: "Server settings", note: "Uses the model set in the server's .env file." } };
    }
    return { classifier: null, plan: { kind: "none", name: "", provider: "", note: "No AI provider is connected, so emails get no mood tag. Drafts still work once a provider is connected." } };
  }

  providers(): ProviderView[] {
    return KEY_PROVIDERS.map((kind) => {
      const spec = PROVIDER_SPECS[kind];
      const meta = this.readJson(META(kind), Meta);
      return {
        kind,
        label: spec.label,
        keyUrl: spec.keyUrl,
        keyOptional: Boolean(spec.keyOptional),
        needsBaseUrl: kind === "custom",
        connected: Boolean(meta),
        keyHint: meta?.keyHint ?? "",
        baseUrl: meta?.baseUrl ?? spec.baseUrl,
        test: meta?.test ?? null,
      };
    });
  }

  chatgptView() {
    const session = this.chatgptSession();
    const account = this.readJson(CHATGPT_ACCOUNT, z.object({ clientId: z.string(), subject: z.string(), email: z.string() }));
    return {
      connected: Boolean(session),
      email: session?.email ?? account?.email ?? "",
      planEnabled: Boolean(session?.scopes.includes(CHATGPT.planScope)),
      registered: Boolean(account),
      welcomePending: Boolean(session?.scopes.includes(CHATGPT.planScope)) && !this.store.setting(CHATGPT_WELCOMED),
      usageUrl: CHATGPT.usageUrl,
    };
  }

  markWelcomed() {
    this.store.setSetting(CHATGPT_WELCOMED, new Date(this.clock()).toISOString());
  }
}
