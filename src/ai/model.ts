import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export type ModelRequest<T> = {
  task: "analyze" | "draft" | "lesson" | "assist" | "classify";
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
};

/** Returns one JSON value that matches the schema, or throws. */
export interface ModelProvider {
  readonly name: string;
  json<T>(request: ModelRequest<T>): Promise<T>;
}

export class ModelError extends Error {
  override name = "ModelError";
}

/** Replaces every secret in a message, so a provider that echoes a key back never puts it in a log or a draft error. */
export function redact(text: string, secrets: Array<string | undefined>) {
  let out = text;
  for (const secret of secrets) if (secret && secret.length >= 6) out = out.split(secret).join("[redacted]");
  return out;
}

/** The JSON Schema for a request, without the `$schema` key that some providers reject. */
export function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}

export function validate<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ModelError(`The model reply did not match the expected shape: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  return parsed.data;
}

/** Reads a provider error body into one short line, with secrets removed. */
export async function providerError(label: string, response: Response, secrets: Array<string | undefined>) {
  let detail = "";
  try {
    const text = await response.text();
    try {
      const body = JSON.parse(text) as { error?: { message?: string; code?: string } | string; detail?: string; message?: string };
      detail = typeof body.error === "string" ? body.error : (body.error?.message ?? body.detail ?? body.message ?? "");
    } catch {
      detail = text;
    }
  } catch {
    detail = "";
  }
  detail = redact(detail.replace(/\s+/g, " ").trim().slice(0, 200), secrets);
  return new ModelError(`${label} returned HTTP ${response.status}${detail ? `: ${detail}` : "."}`);
}

export function parseJson<T>(schema: z.ZodType<T>, text: string): T {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new ModelError("The model did not return JSON.");
  let value: unknown;
  try {
    value = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new ModelError("The model returned malformed JSON.");
  }
  return validate(schema, value);
}

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Any server that speaks the OpenAI chat completions API: OpenAI, OpenRouter, Groq, Mistral, Ollama, vLLM, LM Studio.
 * `jsonMode: "object"` asks for plain JSON and puts the schema in the system message, for servers without JSON Schema output.
 */
export class OpenAICompatibleModel implements ModelProvider {
  readonly name: string;

  constructor(
    private readonly options: { baseUrl: string; apiKey: string; model: string; timeoutMs?: number; jsonMode?: "schema" | "object"; label?: string },
    private readonly fetcher: Fetch = fetch,
  ) {
    this.name = options.model;
  }

  async json<T>(request: ModelRequest<T>): Promise<T> {
    const schema = jsonSchema(request.schema);
    const objectMode = this.options.jsonMode === "object";
    const system = objectMode ? `${request.system}\n\nReply with one JSON object that matches this JSON Schema:\n${JSON.stringify(schema)}` : request.system;
    const response = await this.fetcher(`${this.options.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}) },
      body: JSON.stringify({
        model: this.options.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: request.prompt },
        ],
        response_format: objectMode ? { type: "json_object" } : { type: "json_schema", json_schema: { name: request.task, schema } },
      }),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 120_000),
    });
    if (!response.ok) throw await providerError(this.options.label ?? "The model API", response, [this.options.apiKey]);
    const body = z
      .object({ choices: z.array(z.object({ message: z.object({ content: z.string().nullable() }) })).min(1) })
      .parse(await response.json());
    return parseJson(request.schema, body.choices[0]!.message.content ?? "");
  }
}

export type CodexRunner = (args: string[], options: { timeoutMs: number }) => Promise<{ exitCode: number; stderr: string }>;

const spawnCodex =
  (binary: string): CodexRunner =>
  async (args, options) => {
    const child = Bun.spawn([binary, ...args], { stdout: "ignore", stderr: "pipe", stdin: "ignore" });
    const timer = setTimeout(() => child.kill(), options.timeoutMs);
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    clearTimeout(timer);
    return { exitCode, stderr };
  };

/** Runs the local Codex CLI, which uses the ChatGPT sign-in of whoever runs `codex login` on this machine. */
export class CodexModel implements ModelProvider {
  readonly name: string;

  constructor(
    private readonly options: { model?: string; binary?: string; timeoutMs?: number },
    private readonly run: CodexRunner = spawnCodex(options.binary ?? "codex"),
  ) {
    this.name = options.model ? `codex:${options.model}` : "codex";
  }

  async json<T>(request: ModelRequest<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), "replyfold-codex-"));
    try {
      const schemaPath = join(dir, "schema.json");
      const outputPath = join(dir, "output.json");
      await writeFile(schemaPath, JSON.stringify(jsonSchema(request.schema)));
      const args = [
        "exec",
        "--skip-git-repo-check",
        "--ephemeral",
        "--sandbox",
        "read-only",
        "--cd",
        dir,
        "--output-schema",
        schemaPath,
        "--output-last-message",
        outputPath,
        ...(this.options.model ? ["--model", this.options.model] : []),
        `${request.system}\n\n${request.prompt}`,
      ];
      const result = await this.run(args, { timeoutMs: this.options.timeoutMs ?? 180_000 });
      if (result.exitCode !== 0) {
        const hint = /login|auth|401/i.test(result.stderr) ? " Run `codex login` on the server." : "";
        throw new ModelError(`Codex exited with code ${result.exitCode}.${hint}`);
      }
      return parseJson(request.schema, await readFile(outputPath, "utf8"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
