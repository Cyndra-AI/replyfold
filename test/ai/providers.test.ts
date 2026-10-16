import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { ModelError } from "../../src/ai/model";
import { ChatGPTPlanError, ChatGPTPlanModel, createKeyModel, listChatGPTModels, listKeyModels, maskKey, readResponseStream, type KeyProviderKind } from "../../src/ai/providers";

const schema = z.object({ answer: z.string() });
const request = { task: "draft" as const, system: "be brief", prompt: "say yes", schema };
const KEY = `${"fake".repeat(4)}cdef`;

type Call = { url: string; method: string; headers: Record<string, string>; body: any };

function recorder(reply: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetcher = async (url: string, init?: RequestInit) => {
    const call: Call = {
      url,
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    };
    calls.push(call);
    return reply(call);
  };
  return { calls, fetcher };
}

const chat = (content: string) => Response.json({ choices: [{ message: { content } }] });

describe("draft request shape per provider", () => {
  const openAiWire: Array<[KeyProviderKind, string, "json_schema" | "json_object"]> = [
    ["openai", "https://api.openai.com/v1/chat/completions", "json_schema"],
    ["openrouter", "https://openrouter.ai/api/v1/chat/completions", "json_schema"],
    ["groq", "https://api.groq.com/openai/v1/chat/completions", "json_object"],
    ["mistral", "https://api.mistral.ai/v1/chat/completions", "json_schema"],
  ];

  for (const [kind, url, format] of openAiWire) {
    test(`${kind} posts chat completions with a bearer key`, async () => {
      const { calls, fetcher } = recorder(() => chat('{"answer":"yes"}'));
      const model = createKeyModel(kind, { apiKey: KEY }, "some-model", fetcher);
      expect(await model.json(request)).toEqual({ answer: "yes" });
      expect(calls[0]!.url).toBe(url);
      expect(calls[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
      expect(calls[0]!.body.model).toBe("some-model");
      expect(calls[0]!.body.response_format.type).toBe(format);
      expect(calls[0]!.body.messages.map((message: { role: string }) => message.role)).toEqual(["system", "user"]);
      if (format === "json_object") expect(calls[0]!.body.messages[0].content).toContain('"answer"');
      else expect(calls[0]!.body.response_format.json_schema.schema.$schema).toBeUndefined();
    });
  }

  test("a custom server uses its own base URL and may have no key", async () => {
    const { calls, fetcher } = recorder(() => chat('{"answer":"local"}'));
    const model = createKeyModel("custom", { apiKey: "", baseUrl: "http://localhost:11434/v1/" }, "llama", fetcher);
    expect(await model.json(request)).toEqual({ answer: "local" });
    expect(calls[0]!.url).toBe("http://localhost:11434/v1/chat/completions");
    expect(calls[0]!.headers.authorization).toBeUndefined();
  });

  test("anthropic forces one tool call and reads its input", async () => {
    const { calls, fetcher } = recorder(() => Response.json({ content: [{ type: "tool_use", name: "draft", input: { answer: "from claude" } }] }));
    const model = createKeyModel("anthropic", { apiKey: KEY }, "claude-test", fetcher);
    expect(await model.json(request)).toEqual({ answer: "from claude" });
    const call = calls[0]!;
    expect(call.url).toBe("https://api.anthropic.com/v1/messages");
    expect(call.headers["x-api-key"]).toBe(KEY);
    expect(call.headers["anthropic-version"]).toBe("2023-06-01");
    expect(call.headers.authorization).toBeUndefined();
    expect(call.body.system).toBe("be brief");
    expect(call.body.tool_choice).toEqual({ type: "tool", name: "draft" });
    expect(call.body.tools[0].input_schema.properties.answer.type).toBe("string");
    expect(call.body.max_tokens).toBeGreaterThan(0);
  });

  test("gemini asks generateContent for JSON Schema output", async () => {
    const { calls, fetcher } = recorder(() => Response.json({ candidates: [{ content: { parts: [{ text: '{"answer":"from gemini"}' }] } }] }));
    const model = createKeyModel("gemini", { apiKey: KEY }, "gemini-test", fetcher);
    expect(await model.json(request)).toEqual({ answer: "from gemini" });
    const call = calls[0]!;
    expect(call.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent");
    expect(call.headers["x-goog-api-key"]).toBe(KEY);
    expect(call.url).not.toContain(KEY);
    expect(call.body.systemInstruction.parts[0].text).toBe("be brief");
    expect(call.body.generationConfig.responseMimeType).toBe("application/json");
    expect(call.body.generationConfig.responseJsonSchema.properties.answer.type).toBe("string");
  });
});

describe("live model lists", () => {
  test("openai lists chat models and drops embeddings and audio", async () => {
    const { calls, fetcher } = recorder(() => Response.json({ data: [{ id: "gpt-test" }, { id: "text-embedding-3-small" }, { id: "whisper-1" }] }));
    expect(await listKeyModels("openai", { apiKey: KEY }, fetcher)).toEqual([{ id: "gpt-test", label: "gpt-test" }]);
    expect(calls[0]!.url).toBe("https://api.openai.com/v1/models");
  });

  test("openrouter checks the key first, because its model list is public", async () => {
    const { calls, fetcher } = recorder((call) => (call.url.endsWith("/key") ? Response.json({ data: { label: "x" } }) : Response.json({ data: [{ id: "a/b", name: "A: B" }] })));
    expect(await listKeyModels("openrouter", { apiKey: KEY }, fetcher)).toEqual([{ id: "a/b", label: "A: B" }]);
    expect(calls.map((call) => call.url)).toEqual(["https://openrouter.ai/api/v1/key", "https://openrouter.ai/api/v1/models"]);
  });

  test("anthropic and gemini use their own list endpoints and headers", async () => {
    const anthropic = recorder(() => Response.json({ data: [{ id: "claude-test", display_name: "Claude Test" }] }));
    expect(await listKeyModels("anthropic", { apiKey: KEY }, anthropic.fetcher)).toEqual([{ id: "claude-test", label: "Claude Test" }]);
    expect(anthropic.calls[0]!.url).toBe("https://api.anthropic.com/v1/models?limit=1000");
    expect(anthropic.calls[0]!.headers["x-api-key"]).toBe(KEY);

    const gemini = recorder(() =>
      Response.json({
        models: [
          { name: "models/gemini-test", displayName: "Gemini Test", supportedGenerationMethods: ["generateContent"] },
          { name: "models/embedding-test", supportedGenerationMethods: ["embedContent"] },
        ],
      }),
    );
    expect(await listKeyModels("gemini", { apiKey: KEY }, gemini.fetcher)).toEqual([{ id: "gemini-test", label: "Gemini Test" }]);
    expect(gemini.calls[0]!.headers["x-goog-api-key"]).toBe(KEY);
  });

  test("the ChatGPT catalog keeps only listed models, in the server's order", async () => {
    const { calls, fetcher } = recorder(() =>
      Response.json({ models: [{ slug: "b-model", display_name: "B", visibility: "list" }, { slug: "hidden", visibility: "hide" }, { slug: "a-model", display_name: "A", visibility: "list" }] }),
    );
    expect(await listChatGPTModels("access-token", fetcher)).toEqual([
      { id: "b-model", label: "B" },
      { id: "a-model", label: "A" },
    ]);
    expect(calls[0]!.url).toBe("https://api.openai.com/v1/models");
  });
});

describe("keys stay secret", () => {
  test("a masked key shows only its last four characters", () => {
    expect(maskKey(KEY)).toBe("••••cdef");
    expect(maskKey(KEY)).not.toContain(KEY.slice(0, 8));
    expect(maskKey("short")).toBe("••••");
    expect(maskKey("")).toBe("");
  });

  test("an error that echoes the key back is redacted", async () => {
    const { fetcher } = recorder(() => Response.json({ error: { message: `Incorrect API key provided: ${KEY}.` } }, { status: 401 }));
    for (const kind of ["openai", "anthropic", "gemini"] as const) {
      const error = await createKeyModel(kind, { apiKey: KEY }, "m", fetcher)
        .json(request)
        .catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(ModelError);
      expect(String((error as Error).message)).toContain("401");
      expect(String((error as Error).message)).not.toContain(KEY);
    }
    const listed = await listKeyModels("mistral", { apiKey: KEY }, fetcher).catch((failure: Error) => failure.message);
    expect(listed).not.toContain(KEY);
  });
});

function sse(events: unknown[]) {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

describe("ChatGPT plan model", () => {
  test("streams the Responses API with store false and reads the text", async () => {
    const { calls, fetcher } = recorder(() =>
      sse([
        { type: "response.created" },
        { type: "response.output_text.delta", delta: '{"answer":' },
        { type: "response.output_text.delta", delta: '"plan"}' },
        { type: "response.completed", response: {} },
      ]),
    );
    const model = new ChatGPTPlanModel({ accessToken: async () => "access-token", model: "gpt-test" }, fetcher);
    expect(await model.json(request)).toEqual({ answer: "plan" });
    const call = calls[0]!;
    expect(call.url).toBe("https://api.openai.com/v1/responses");
    expect(call.headers.authorization).toBe("Bearer access-token");
    expect(call.body).toMatchObject({ model: "gpt-test", instructions: "be brief", store: false, stream: true });
    expect(call.body.input).toEqual([{ role: "user", content: "say yes" }]);
    for (const field of ["temperature", "max_output_tokens", "previous_response_id", "metadata", "user"]) expect(call.body[field]).toBeUndefined();
  });

  test("a usage limit after streaming began becomes a clear error", async () => {
    const response = sse([{ type: "response.output_text.delta", delta: "{" }, { type: "response.failed", response: { error: { code: "subscription_sharing_usage_limit_exceeded" } } }]);
    const error = await readResponseStream(response).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(ChatGPTPlanError);
    expect((error as ChatGPTPlanError).reason).toBe("usage_limit");
  });

  test("a stream without response.completed is not a success", async () => {
    await expect(readResponseStream(sse([{ type: "response.output_text.delta", delta: '{"answer":"x"}' }]))).rejects.toThrow("ended early");
  });
});
