import { describe, expect, test } from "bun:test";
import type { ModelProvider, ModelRequest } from "../../src/ai/model";
import { Store } from "../../src/db/store";
import { acceptSuggestion, learnFromEdit } from "../../src/drafts/learning";

function sentDraft(store: Store, editClass: "light" | "heavy") {
  const mailbox = store.createMailbox({ provider: "demo", address: "help@shop.test", displayName: "Support", credentials: "{}" });
  const conversation = store.createConversation({
    mailboxId: mailbox.id,
    threadHint: null,
    subject: "Broken mug",
    customer: { name: "Ana", email: "ana@example.net" },
    at: "2026-03-01T00:00:00Z",
  });
  const draft = store.createDraft({ conversationId: conversation.id, forMessageId: "m" });
  store.updateDraft(draft.id, { state: "sent", body: "Please send it back.", sentBody: "We will send a new mug. No need to return it.", editClass });
  return draft.id;
}

const lessonModel = (generalizes: boolean): ModelProvider => ({
  name: "scripted",
  async json<T>(request: ModelRequest<T>) {
    return request.schema.parse({
      generalizes,
      category: "policy",
      summary: "The draft asked for a return on a broken item.",
      rule: "Do not ask customers to return broken items.",
    });
  },
});

describe("learnFromEdit", () => {
  test("a heavy edit with a general lesson becomes a pending suggestion", async () => {
    const store = new Store();
    store.savePlaybook("Be kind.", "", null);
    const lesson = await learnFromEdit({ store, model: lessonModel(true), draftId: sentDraft(store, "heavy") });
    expect(lesson?.category).toBe("policy");
    expect(store.suggestions("pending").map((item) => item.rule)).toEqual(["Do not ask customers to return broken items."]);
  });

  test("a one-off lesson is recorded without a suggestion", async () => {
    const store = new Store();
    await learnFromEdit({ store, model: lessonModel(false), draftId: sentDraft(store, "heavy") });
    expect(store.lessons()).toHaveLength(1);
    expect(store.suggestions()).toEqual([]);
  });

  test("a light edit teaches nothing", async () => {
    const store = new Store();
    expect(await learnFromEdit({ store, model: lessonModel(true), draftId: sentDraft(store, "light") })).toBeNull();
  });
});

describe("acceptSuggestion", () => {
  test("appends the rule as a new playbook version once", async () => {
    const store = new Store();
    store.savePlaybook("Be kind.", "", null);
    await learnFromEdit({ store, model: lessonModel(true), draftId: sentDraft(store, "heavy") });
    const [suggestion] = store.suggestions("pending");
    const version = acceptSuggestion({ store, suggestionId: suggestion!.id, userId: "u1" });
    expect(version.content).toBe("Be kind.\n\n## Learned from edits\n\n- Do not ask customers to return broken items.\n");
    expect(store.playbookVersions()).toHaveLength(2);
    expect(() => acceptSuggestion({ store, suggestionId: suggestion!.id, userId: "u1" })).toThrow("already handled");
  });
});
