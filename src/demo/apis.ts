import { z } from "zod";
import { DemoModel } from "./model";

/**
 * Demo mode answers the built-in AI providers on the server itself, so the AI settings can be tried
 * with made-up keys. Model names are examples, not a live catalog. Other addresses, such as a custom
 * server or the ChatGPT sign-in, still get real requests.
 */
const MODELS: Record<string, string[]> = {
  "https://api.openai.com/v1/models": ["gpt-6-sol", "gpt-6-luna", "gpt-6-luna-pro"],
  "https://api.groq.com/openai/v1/models": ["llama-4-scout-instant", "qwen-3-32b"],
  "https://api.mistral.ai/v1/models": ["mistral-medium-latest", "mistral-small-latest"],
  "https://openrouter.ai/api/v1/models": ["openai/gpt-6-luna", "anthropic/claude-haiku-5-5", "google/gemini-3.8-flash"],
};

const model = new DemoModel();
const any = z.any();

function taskOf(prompt: string, named?: string) {
  if (named) return named;
  if (prompt.startsWith("category, one of")) return "classify";
  if (prompt.startsWith("You are the analyst")) return "analyze";
  return "draft";
}

async function answer(task: string, system: string, prompt: string) {
  return model.json({ task: task as "draft", system, prompt, schema: any });
}

export const demoFetch = async (input: string, init?: RequestInit): Promise<Response> => {
  const url = input.split("?")[0]!;
  const body = init?.body && typeof init.body === "string" ? JSON.parse(init.body) : null;
  if (MODELS[url] && !input.includes("output_modalities")) return Response.json({ data: MODELS[url].map((id) => ({ id, name: id })) });
  if (url === "https://openrouter.ai/api/v1/models") {
    return Response.json({ data: [{ id: "~typesafe/jev-latest", name: "TypeSafe: Jev Latest", created: 2, pricing: { prompt: "0.000000042" } }] });
  }
  if (url === "https://openrouter.ai/api/v1/key") return Response.json({ data: { label: "demo" } });
  if (url === "https://api.anthropic.com/v1/models") return Response.json({ data: [{ id: "claude-opus-5-5", display_name: "Claude Opus 5.5" }, { id: "claude-haiku-5-5", display_name: "Claude Haiku 5.5" }] });
  if (url === "https://generativelanguage.googleapis.com/v1beta/models") {
    return Response.json({ models: [{ name: "models/gemini-3.8-pro", displayName: "Gemini 3.8 Pro", supportedGenerationMethods: ["generateContent"] }, { name: "models/gemini-3.8-flash", displayName: "Gemini 3.8 Flash", supportedGenerationMethods: ["generateContent"] }] });
  }
  if (url === "https://openrouter.ai/api/v1/systemone") {
    const state = body.state as { subject: string; email: string };
    const result = (await answer("classify", "", `<EMAIL subject=${JSON.stringify(state.subject)}>\n${state.email}\n</EMAIL>`)) as { category: string; mood: string };
    return Response.json({ model: body.model, answers: { category: { type: "choice", choice: result.category }, mood: { type: "choice", choice: result.mood } }, usage: { cost: 0.00001 } });
  }
  if (url.endsWith("/chat/completions")) {
    const task = taskOf(body.messages[1].content, body.response_format?.json_schema?.name);
    const result = await answer(task, body.messages[0].content, body.messages[1].content);
    return Response.json({ choices: [{ message: { content: JSON.stringify(result) } }] });
  }
  if (url === "https://api.anthropic.com/v1/messages") {
    const task = body.tool_choice.name;
    return Response.json({ content: [{ type: "tool_use", name: task, input: await answer(task, body.system, body.messages[0].content) }] });
  }
  if (url.startsWith("https://generativelanguage.googleapis.com/v1beta/models/")) {
    const prompt = body.contents[0].parts[0].text as string;
    const task = taskOf(prompt);
    return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(await answer(task, body.systemInstruction.parts[0].text, prompt)) }] } }] });
  }
  return fetch(input, init);
};
