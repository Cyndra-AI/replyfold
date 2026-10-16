import { z } from "zod";
import { jsonSchema, ModelError, OpenAICompatibleModel, parseJson, providerError, redact, validate, type Fetch, type ModelProvider, type ModelRequest } from "./model";

export const KEY_PROVIDERS = ["openai", "anthropic", "gemini", "openrouter", "groq", "mistral", "custom"] as const;
export type KeyProviderKind = (typeof KEY_PROVIDERS)[number];
export type AiProviderKind = KeyProviderKind | "chatgpt";

type Wire = "openai" | "anthropic" | "gemini";

export type ProviderSpec = {
  label: string;
  wire: Wire;
  /** Fixed API base. Empty for the custom server, where the user types it. */
  baseUrl: string;
  /** Where the user creates a key. */
  keyUrl: string;
  keyOptional?: boolean;
  jsonMode?: "schema" | "object";
};

export const PROVIDER_SPECS: Record<KeyProviderKind, ProviderSpec> = {
  openai: { label: "OpenAI", wire: "openai", baseUrl: "https://api.openai.com/v1", keyUrl: "https://platform.openai.com/api-keys" },
  anthropic: { label: "Anthropic", wire: "anthropic", baseUrl: "https://api.anthropic.com/v1", keyUrl: "https://platform.claude.com/settings/keys" },
  gemini: { label: "Google Gemini", wire: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", keyUrl: "https://aistudio.google.com/apikey" },
  openrouter: { label: "OpenRouter", wire: "openai", baseUrl: "https://openrouter.ai/api/v1", keyUrl: "https://openrouter.ai/settings/keys" },
  // Groq offers JSON Schema output on a few models only. JSON object mode works on all of them.
  groq: { label: "Groq", wire: "openai", baseUrl: "https://api.groq.com/openai/v1", keyUrl: "https://console.groq.com/keys", jsonMode: "object" },
  mistral: { label: "Mistral", wire: "openai", baseUrl: "https://api.mistral.ai/v1", keyUrl: "https://console.mistral.ai/api-keys" },
  custom: { label: "OpenAI-compatible server", wire: "openai", baseUrl: "", keyUrl: "", keyOptional: true },
};

export type KeyCredentials = { apiKey: string; baseUrl?: string };
export type ModelChoice = { id: string; label: string };

const ANTHROPIC_VERSION = "2023-06-01";
const TIMEOUT_MS = 120_000;

export function baseUrlFor(kind: KeyProviderKind, credentials: KeyCredentials) {
  return (kind === "custom" ? (credentials.baseUrl ?? "") : PROVIDER_SPECS[kind].baseUrl).replace(/\/$/, "");
}

/** Shows only the last four characters of a key. */
export function maskKey(key: string) {
  if (!key) return "";
  return key.length <= 8 ? "••••" : `••••${key.slice(-4)}`;
}

/** Claude through the Messages API. A forced tool call returns the JSON, so the reply always has the schema's shape. */
export class AnthropicModel implements ModelProvider {
  readonly name: string;

  constructor(
    private readonly options: { apiKey: string; model: string; timeoutMs?: number },
    private readonly fetcher: Fetch = fetch,
  ) {
    this.name = options.model;
  }

  async json<T>(request: ModelRequest<T>): Promise<T> {
    const response = await this.fetcher(`${PROVIDER_SPECS.anthropic.baseUrl}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": this.options.apiKey, "anthropic-version": ANTHROPIC_VERSION },
      body: JSON.stringify({
        model: this.options.model,
        max_tokens: 4096,
        system: request.system,
        messages: [{ role: "user", content: request.prompt }],
        tools: [{ name: request.task, description: "Return the result as the tool input.", input_schema: jsonSchema(request.schema) }],
        tool_choice: { type: "tool", name: request.task },
      }),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? TIMEOUT_MS),
    });
    if (!response.ok) throw await providerError("Anthropic", response, [this.options.apiKey]);
    const body = z.object({ content: z.array(z.object({ type: z.string(), name: z.string().optional(), input: z.unknown().optional() })) }).parse(await response.json());
    const call = body.content.find((block) => block.type === "tool_use" && block.name === request.task);
    if (!call) throw new ModelError("Claude did not return the expected result.");
    return validate(request.schema, call.input);
  }
}

/** Gemini through generateContent with JSON Schema output. */
export class GeminiModel implements ModelProvider {
  readonly name: string;

  constructor(
    private readonly options: { apiKey: string; model: string; timeoutMs?: number },
    private readonly fetcher: Fetch = fetch,
  ) {
    this.name = options.model;
  }

  async json<T>(request: ModelRequest<T>): Promise<T> {
    const response = await this.fetcher(`${PROVIDER_SPECS.gemini.baseUrl}/models/${encodeURIComponent(this.options.model)}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": this.options.apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: request.system }] },
        contents: [{ role: "user", parts: [{ text: request.prompt }] }],
        generationConfig: { responseMimeType: "application/json", responseJsonSchema: jsonSchema(request.schema) },
      }),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? TIMEOUT_MS),
    });
    if (!response.ok) throw await providerError("Gemini", response, [this.options.apiKey]);
    const body = z
      .object({ candidates: z.array(z.object({ content: z.object({ parts: z.array(z.object({ text: z.string().optional() })).default([]) }).optional() })).default([]) })
      .parse(await response.json());
    const text = body.candidates[0]?.content?.parts.map((part) => part.text ?? "").join("") ?? "";
    return parseJson(request.schema, text);
  }
}

export type ChatGPTUsageError = "usage_limit" | "not_eligible";

/** Thrown when the ChatGPT plan cannot serve a request. The settings page explains what to do. */
export class ChatGPTPlanError extends ModelError {
  constructor(
    message: string,
    readonly reason: ChatGPTUsageError | "signed_out" | "other",
  ) {
    super(message);
  }
}

const PLAN_MESSAGES: Record<string, { text: string; reason: ChatGPTPlanError["reason"] }> = {
  subscription_sharing_usage_limit_exceeded: { text: "The ChatGPT plan usage limit was reached. Check it in ChatGPT settings under Usage.", reason: "usage_limit" },
  subscription_sharing_user_not_eligible: { text: "This ChatGPT account cannot use its plan in other apps.", reason: "not_eligible" },
  subscription_sharing_invalid_user: { text: "ChatGPT did not accept the sign-in. Connect ChatGPT again in settings.", reason: "signed_out" },
};

function planError(code: string | undefined, fallback: string) {
  const known = code ? PLAN_MESSAGES[code] : undefined;
  return known ? new ChatGPTPlanError(known.text, known.reason) : new ChatGPTPlanError(fallback, "other");
}

/**
 * Uses the signed-in person's ChatGPT plan through the Responses API, as the official
 * "ChatGPT plan usage" docs require: `store: false`, `stream: true`, and success only on `response.completed`.
 */
export class ChatGPTPlanModel implements ModelProvider {
  readonly name: string;

  constructor(
    private readonly options: { accessToken: () => Promise<string>; model: string; timeoutMs?: number },
    private readonly fetcher: Fetch = fetch,
  ) {
    this.name = `chatgpt:${options.model}`;
  }

  async json<T>(request: ModelRequest<T>): Promise<T> {
    const token = await this.options.accessToken();
    const response = await this.fetcher("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, accept: "text/event-stream" },
      body: JSON.stringify({
        model: this.options.model,
        instructions: request.system,
        input: [{ role: "user", content: request.prompt }],
        text: { format: { type: "json_schema", name: request.task, schema: jsonSchema(request.schema), strict: false } },
        store: false,
        stream: true,
      }),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? TIMEOUT_MS),
    });
    if (!response.ok) {
      const raw = redact(await response.text().catch(() => ""), [token]);
      let code: string | undefined;
      try {
        code = (JSON.parse(raw) as { error?: { code?: string } }).error?.code;
      } catch {
        code = undefined;
      }
      throw planError(code, `ChatGPT returned HTTP ${response.status}.`);
    }
    const text = await readResponseStream(response);
    return parseJson(request.schema, text);
  }
}

/** Collects output text from a Responses API event stream. Throws unless the stream ends with `response.completed`. */
export async function readResponseStream(response: Response) {
  if (!response.body) throw new ModelError("ChatGPT sent an empty reply.");
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let text = "";
  let done = false;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += chunk.value;
    let split = buffer.indexOf("\n\n");
    while (split >= 0) {
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      split = buffer.indexOf("\n\n");
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data || data === "[DONE]") continue;
      let event: { type?: string; delta?: string; response?: { error?: { code?: string; message?: string } | null } };
      try {
        event = JSON.parse(data);
      } catch {
        continue;
      }
      if (event.type === "response.output_text.delta" && typeof event.delta === "string") text += event.delta;
      else if (event.type === "response.completed") done = true;
      else if (event.type === "response.failed") throw planError(event.response?.error?.code, "ChatGPT could not finish the reply.");
      else if (event.type === "response.incomplete") throw new ChatGPTPlanError("ChatGPT stopped before the reply was complete.", "other");
      else if (event.type === "error") throw planError((event as { code?: string }).code, "ChatGPT reported an error.");
    }
  }
  if (!done) throw new ChatGPTPlanError("The ChatGPT reply ended early. Try again.", "other");
  return text;
}

export function createKeyModel(kind: KeyProviderKind, credentials: KeyCredentials, model: string, fetcher: Fetch = fetch): ModelProvider {
  const spec = PROVIDER_SPECS[kind];
  switch (spec.wire) {
    case "anthropic":
      return new AnthropicModel({ apiKey: credentials.apiKey, model }, fetcher);
    case "gemini":
      return new GeminiModel({ apiKey: credentials.apiKey, model }, fetcher);
    case "openai":
      return new OpenAICompatibleModel({ baseUrl: baseUrlFor(kind, credentials), apiKey: credentials.apiKey, model, jsonMode: spec.jsonMode, label: spec.label }, fetcher);
  }
}

// Model ids on OpenAI's list that cannot write a chat reply.
const NOT_CHAT = /embedding|whisper|tts|dall-e|gpt-image|image|moderation|transcribe|realtime|audio|search|computer-use|babbage|davinci/i;

const openAiList = z.object({ data: z.array(z.object({ id: z.string(), name: z.string().optional() })) });

function bySorted(models: ModelChoice[]) {
  return models.sort((a, b) => a.label.localeCompare(b.label));
}

/** Reads the provider's own model list with the given key. Throws a redacted error when the key is refused. */
export async function listKeyModels(kind: KeyProviderKind, credentials: KeyCredentials, fetcher: Fetch = fetch): Promise<ModelChoice[]> {
  const spec = PROVIDER_SPECS[kind];
  const base = baseUrlFor(kind, credentials);
  if (!base) throw new ModelError("Add the server's base URL first.");
  const secrets = [credentials.apiKey];
  const get = async (url: string, headers: Record<string, string>) => {
    const response = await fetcher(url, { headers, signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw await providerError(spec.label, response, secrets);
    return response.json();
  };
  const bearer: Record<string, string> = credentials.apiKey ? { authorization: `Bearer ${credentials.apiKey}` } : {};
  switch (kind) {
    case "anthropic": {
      const body = z
        .object({ data: z.array(z.object({ id: z.string(), display_name: z.string().optional() })) })
        .parse(await get(`${base}/models?limit=1000`, { "x-api-key": credentials.apiKey, "anthropic-version": ANTHROPIC_VERSION }));
      return body.data.map((model) => ({ id: model.id, label: model.display_name ?? model.id }));
    }
    case "gemini": {
      const body = z
        .object({ models: z.array(z.object({ name: z.string(), displayName: z.string().optional(), supportedGenerationMethods: z.array(z.string()).default([]) })).default([]) })
        .parse(await get(`${base}/models?pageSize=1000`, { "x-goog-api-key": credentials.apiKey }));
      return body.models
        .filter((model) => model.supportedGenerationMethods.includes("generateContent"))
        .map((model) => ({ id: model.name.replace(/^models\//, ""), label: model.displayName ?? model.name.replace(/^models\//, "") }));
    }
    case "openrouter": {
      // The model list is public, so check the key itself first.
      await get(`${base}/key`, bearer);
      const body = openAiList.parse(await get(`${base}/models`, bearer));
      return bySorted(body.data.map((model) => ({ id: model.id, label: model.name ?? model.id })));
    }
    default: {
      const body = openAiList.parse(await get(`${base}/models`, bearer));
      const models = body.data.map((model) => ({ id: model.id, label: model.name ?? model.id }));
      return bySorted(kind === "openai" ? models.filter((model) => !NOT_CHAT.test(model.id)) : models);
    }
  }
}

/** The signed-in account's model catalog, in the server's order, as the ChatGPT plan docs describe. */
export async function listChatGPTModels(accessToken: string, fetcher: Fetch = fetch): Promise<ModelChoice[]> {
  const response = await fetcher("https://api.openai.com/v1/models", { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw await providerError("ChatGPT", response, [accessToken]);
  const body = z
    .object({ models: z.array(z.object({ slug: z.string(), display_name: z.string().optional(), visibility: z.string().optional() })) })
    .parse(await response.json());
  return body.models.filter((model) => model.visibility === "list").map((model) => ({ id: model.slug, label: model.display_name ?? model.slug }));
}
