import { describe, expect, test } from "bun:test";
import { findJevModel, JevClassifier, ModelClassifier, pickSmallModel } from "../../src/ai/classifier";
import { AiSettings } from "../../src/ai/settings";
import { SecretBox } from "../../src/core/secrets";
import { Store } from "../../src/db/store";
import { DemoModel } from "../../src/demo/model";

const OPENROUTER_KEY = `router-${"fake".repeat(4)}`;
const OPENAI_KEY = `openai-${"fake".repeat(4)}`;

type Call = { url: string; body: any; headers: Record<string, string> };

function fakeApis(options: { jev?: boolean; openaiModels?: string[] } = {}) {
  const calls: Call[] = [];
  const fetcher = async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    if (url.startsWith("https://openrouter.ai/api/v1/models?output_modalities=decisions")) {
      return Response.json({
        data: options.jev === false ? [] : [
          { id: "typesafe/jev-router", created: 3 },
          { id: "typesafe/jev-1.13", name: "TypeSafe: Jev 1.13", created: 1, pricing: { prompt: "0.000000042" } },
          { id: "~typesafe/jev-latest", name: "TypeSafe: Jev Latest", created: 2, pricing: { prompt: "0.000000042" } },
        ],
      });
    }
    if (url === "https://openrouter.ai/api/v1/systemone") {
      return Response.json({ model: "typesafe/jev-1.14", answers: { category: { type: "choice", choice: "billing", confidence: 0.9 }, mood: { type: "choice", choice: "worried" } }, usage: { cost: 0.00001 } });
    }
    if (url === "https://api.openai.com/v1/models") return Response.json({ data: (options.openaiModels ?? ["gpt-6-sol", "gpt-6-luna", "gpt-6-luna-pro", "gpt-5.6-luna"]).map((id) => ({ id })) });
    if (url === "https://api.openai.com/v1/chat/completions") return Response.json({ choices: [{ message: { content: '{"category":"shipping","mood":"calm"}' } }] });
    return new Response("not mocked", { status: 404 });
  };
  return { calls, fetcher };
}

function settings(fetcher: ReturnType<typeof fakeApis>["fetcher"]) {
  return new AiSettings(new Store(), new SecretBox("x".repeat(32)), fetcher);
}

describe("Jev", () => {
  test("finds the latest Jev alias on OpenRouter's live decision models, never the router", async () => {
    const { fetcher } = fakeApis();
    expect(await findJevModel(fetcher)).toEqual({ id: "~typesafe/jev-latest", label: "TypeSafe: Jev Latest", inputPricePerMillion: 0.042 });
    expect(await findJevModel(fakeApis({ jev: false }).fetcher)).toBeNull();
  });

  test("asks the System One API two choice questions about the email", async () => {
    const { calls, fetcher } = fakeApis();
    const jev = new JevClassifier({ apiKey: OPENROUTER_KEY, model: "~typesafe/jev-latest" }, fetcher);
    expect(await jev.classify({ subject: "Charged twice", text: "I see two charges." })).toEqual({ category: "billing", mood: "worried" });
    const call = calls[0]!;
    expect(call.url).toBe("https://openrouter.ai/api/v1/systemone");
    expect(call.headers.authorization).toBe(`Bearer ${OPENROUTER_KEY}`);
    expect(call.body.model).toBe("~typesafe/jev-latest");
    expect(call.body.state).toEqual({ subject: "Charged twice", email: "I see two charges." });
    expect(call.body.questions.category.type).toBe("choice");
    expect(Object.keys(call.body.questions.category.criteria)).toContain("billing");
    expect(Object.keys(call.body.questions.mood.criteria)).toEqual(["happy", "calm", "confused", "worried", "frustrated", "angry"]);
  });
});

describe("small model choice", () => {
  test("prefers the Luna family, newest first, and skips pro and dated snapshots", () => {
    const pick = pickSmallModel(["gpt-6-sol", "gpt-5.6-luna", "gpt-6-luna-pro", "gpt-6-luna-2026-09-01", "gpt-6-luna"].map((id) => ({ id, label: id })));
    expect(pick?.id).toBe("gpt-6-luna");
  });

  test("falls back to other small families, or nothing", () => {
    expect(pickSmallModel([{ id: "claude-opus-5-5", label: "" }, { id: "claude-haiku-5-5", label: "" }])?.id).toBe("claude-haiku-5-5");
    expect(pickSmallModel([{ id: "big-model", label: "" }])).toBeNull();
  });
});

describe("classifier fallback order", () => {
  test("1. Jev, when the OpenRouter key exists and Jev is on", async () => {
    const api = fakeApis();
    const ai = settings(api.fetcher);
    ai.saveKey("openrouter", { apiKey: OPENROUTER_KEY });
    ai.saveKey("openai", { apiKey: OPENAI_KEY });
    ai.setActive({ kind: "openai", model: "gpt-6-sol" });
    ai.saveClassifySettings({ jev: true });
    const { classifier, plan } = await ai.classifier(null);
    expect(classifier).toBeInstanceOf(JevClassifier);
    expect(plan).toMatchObject({ kind: "jev", name: "TypeSafe: Jev Latest", provider: "OpenRouter" });
    expect(plan.note).toContain("$0.042 per million input tokens");
  });

  test("2. the selected provider's small model, read from its live list", async () => {
    const api = fakeApis();
    const ai = settings(api.fetcher);
    ai.saveKey("openai", { apiKey: OPENAI_KEY });
    ai.setActive({ kind: "openai", model: "gpt-6-sol" });
    const { classifier, plan } = await ai.classifier(null);
    expect(classifier).toBeInstanceOf(ModelClassifier);
    expect(plan).toMatchObject({ kind: "model", name: "gpt-6-luna", provider: "OpenAI" });
    await classifier!.classify({ subject: "s", text: "t" });
    const used = api.calls.find((call) => call.url.endsWith("/chat/completions"))!;
    expect(used.body.model).toBe("gpt-6-luna");
    expect(used.body.response_format.json_schema.name).toBe("classify");
  });

  test("2. uses the selected model itself when the list has no small model", async () => {
    const ai = settings(fakeApis({ openaiModels: ["gpt-6-sol"] }).fetcher);
    ai.saveKey("openai", { apiKey: OPENAI_KEY });
    ai.setActive({ kind: "openai", model: "gpt-6-sol" });
    expect((await ai.classifier(null)).plan.name).toBe("gpt-6-sol");
  });

  test("Jev on without a usable Jev model falls through to the small model", async () => {
    const ai = settings(fakeApis({ jev: false }).fetcher);
    ai.saveKey("openrouter", { apiKey: OPENROUTER_KEY });
    ai.saveKey("openai", { apiKey: OPENAI_KEY });
    ai.setActive({ kind: "openai", model: "gpt-6-sol" });
    ai.saveClassifySettings({ jev: true });
    expect((await ai.classifier(null)).plan).toMatchObject({ kind: "model", name: "gpt-6-luna" });
  });

  test("3. the model from .env, then none", async () => {
    const ai = settings(fakeApis().fetcher);
    const fromEnv = await ai.classifier(new DemoModel());
    expect(fromEnv.plan).toMatchObject({ kind: "model", name: "demo" });
    const none = await ai.classifier(null);
    expect(none.classifier).toBeNull();
    expect(none.plan.kind).toBe("none");
  });

  test("Jev cannot be turned on without an OpenRouter key, and removing the key turns it off", () => {
    const ai = settings(fakeApis().fetcher);
    expect(() => ai.saveClassifySettings({ jev: true })).toThrow("Add an OpenRouter key");
    ai.saveKey("openrouter", { apiKey: OPENROUTER_KEY });
    ai.saveClassifySettings({ jev: true });
    ai.removeKey("openrouter");
    expect(ai.classifySettings().jev).toBe(false);
  });
});
