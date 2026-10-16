import { describe, expect, test } from "bun:test";
import type { ModelProvider, ModelRequest } from "../../src/ai/model";
import { ModelError } from "../../src/ai/model";
import { Store } from "../../src/db/store";
import { generateDraft } from "../../src/drafts/workflow";

const analysis = {
  summary: "Customer asks where the order is.",
  intent: "Order status",
  category: "shipping",
  disposition: "reply",
  needsHuman: false,
  missingInformation: [],
  facts: [{ claim: "Order 1042 is late", evidence: ["m1"] }],
  confidence: 0.82,
};

class ScriptedModel implements ModelProvider {
  readonly name = "scripted";
  requests: Array<ModelRequest<unknown>> = [];
  constructor(private replies: Array<unknown | Error>) {}
  async json<T>(request: ModelRequest<T>): Promise<T> {
    this.requests.push(request as ModelRequest<unknown>);
    const next = this.replies.shift();
    if (next instanceof Error) throw next;
    return request.schema.parse(next);
  }
}

function seed() {
  const store = new Store();
  const mailbox = store.createMailbox({ provider: "demo", address: "help@shop.test", displayName: "Support", credentials: "{}" });
  const conversation = store.createConversation({
    mailboxId: mailbox.id,
    threadHint: "t1",
    subject: "Order 1042",
    customer: { name: "Dana Lee", email: "dana@example.com" },
    at: "2026-03-01T10:00:00Z",
  });
  const message = store.insertMessage({
    conversationId: conversation.id,
    mailboxId: mailbox.id,
    externalId: "e1",
    direction: "inbound",
    from: { name: "Dana Lee", email: "dana@example.com" },
    to: [],
    cc: [],
    subject: "Order 1042",
    text: "Where is order 1042?",
    sentAt: "2026-03-01T10:00:00Z",
    messageIdHeader: "<e1@x>",
    references: [],
  })!;
  store.savePlaybook("Greet the customer by first name.", "first", null);
  const draft = store.createDraft({ conversationId: conversation.id, forMessageId: message.id, instruction: "Mention the delay." });
  return { store, conversation, draft };
}

describe("generateDraft", () => {
  test("runs the analyst and the writer and stores a ready draft", async () => {
    const { store, conversation, draft } = seed();
    const model = new ScriptedModel([analysis, { body: "Hello Dana,\n\nOrder 1042 is delayed.", citations: ["m1"] }]);
    const result = await generateDraft({ store, model, draftId: draft.id });
    expect(result.state).toBe("ready");
    expect(result.body).toBe("Hello Dana,\n\nOrder 1042 is delayed.");
    expect(result.issues).toEqual([]);
    expect(result.analysis?.confidence).toBe(0.82);
    expect(store.conversation(conversation.id)?.category).toBe("shipping");
    expect(model.requests.map((request) => request.task)).toEqual(["analyze", "draft"]);
    expect(model.requests[0]?.prompt).toContain("Greet the customer by first name.");
    expect(model.requests[0]?.prompt).toContain("Mention the delay.");
  });

  test("stores no text when the analyst says no reply is needed", async () => {
    const { store, draft } = seed();
    const model = new ScriptedModel([{ ...analysis, disposition: "no_reply" }]);
    const result = await generateDraft({ store, model, draftId: draft.id });
    expect(result.state).toBe("ready");
    expect(result.body).toBe("");
    expect(model.requests).toHaveLength(1);
  });

  test("retries a failed model call once, then marks the draft failed", async () => {
    const { store, draft } = seed();
    const retried = await generateDraft({
      store,
      model: new ScriptedModel([new ModelError("timeout"), analysis, { body: "Hello Dana.", citations: [] }]),
      draftId: draft.id,
    });
    expect(retried.state).toBe("ready");

    const second = seed();
    const failed = await generateDraft({
      store: second.store,
      model: new ScriptedModel([new ModelError("timeout"), new ModelError("timeout again")]),
      draftId: second.draft.id,
    });
    expect(failed.state).toBe("failed");
    expect(failed.error).toBe("timeout again");
  });

  test("leaves a draft alone when a newer message superseded it during generation", async () => {
    const { store, draft, conversation } = seed();
    const model = new ScriptedModel([analysis, { body: "Hello Dana.", citations: [] }]);
    const original = model.json.bind(model);
    model.json = async (request) => {
      if (request.task === "draft") store.supersedeDrafts(conversation.id, "another-message");
      return original(request);
    };
    const result = await generateDraft({ store, model, draftId: draft.id });
    expect(result.state).toBe("discarded");
  });
});
