import { describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { CodexModel, ModelError, OpenAICompatibleModel } from "../../src/ai/model";

const schema = z.object({ answer: z.string() });

describe("OpenAICompatibleModel", () => {
  test("sends the schema and parses the JSON reply", async () => {
    let body: { model: string; response_format: { json_schema: { schema: { type: string } } } } | undefined;
    const model = new OpenAICompatibleModel({ baseUrl: "http://llm.test/v1/", apiKey: "k", model: "small" }, async (url, init) => {
      expect(url).toBe("http://llm.test/v1/chat/completions");
      body = JSON.parse(String(init?.body));
      return Response.json({ choices: [{ message: { content: '```json\n{"answer":"yes"}\n```' } }] });
    });
    expect(await model.json({ task: "draft", system: "s", prompt: "p", schema })).toEqual({ answer: "yes" });
    expect(body?.model).toBe("small");
    expect(body?.response_format.json_schema.schema.type).toBe("object");
  });

  test("rejects a reply that does not match the schema", async () => {
    const model = new OpenAICompatibleModel({ baseUrl: "http://llm.test", apiKey: "", model: "m" }, async () =>
      Response.json({ choices: [{ message: { content: '{"other":1}' } }] }),
    );
    await expect(model.json({ task: "draft", system: "s", prompt: "p", schema })).rejects.toBeInstanceOf(ModelError);
  });
});

describe("CodexModel", () => {
  test("passes the schema file and reads the last message file", async () => {
    let seenSchema = "";
    const model = new CodexModel({ model: "some-model" }, async (args) => {
      seenSchema = await readFile(args[args.indexOf("--output-schema") + 1]!, "utf8");
      await writeFile(args[args.indexOf("--output-last-message") + 1]!, '{"answer":"from codex"}');
      expect(args).toContain("read-only");
      expect(args[args.indexOf("--model") + 1]).toBe("some-model");
      return { exitCode: 0, stderr: "" };
    });
    expect(await model.json({ task: "analyze", system: "s", prompt: "p", schema })).toEqual({ answer: "from codex" });
    expect(JSON.parse(seenSchema).properties.answer.type).toBe("string");
  });

  test("tells the operator to sign in when Codex is not authenticated", async () => {
    const model = new CodexModel({}, async () => ({ exitCode: 1, stderr: "401 Unauthorized" }));
    await expect(model.json({ task: "analyze", system: "s", prompt: "p", schema })).rejects.toThrow("codex login");
  });
});
