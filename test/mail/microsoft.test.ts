import { describe, expect, test } from "bun:test";
import { mapGraphMessage, MicrosoftProvider } from "../../src/mail/microsoft";

const sample = {
  id: "AAMk1",
  conversationId: "conv-1",
  internetMessageId: "<m1@mail.test>",
  subject: "Refund question",
  from: { emailAddress: { name: "Sam Ortiz", address: "Sam@Example.org" } },
  toRecipients: [{ emailAddress: { name: "Support", address: "help@shop.test" } }],
  ccRecipients: [],
  body: { contentType: "html", content: "<div>Can I get a refund?</div>" },
  receivedDateTime: "2026-03-04T08:00:00Z",
  hasAttachments: false,
};

describe("mapGraphMessage", () => {
  test("maps sender, thread and HTML body", () => {
    expect(mapGraphMessage(sample)).toMatchObject({
      externalId: "AAMk1",
      threadHint: "conv-1",
      messageIdHeader: "<m1@mail.test>",
      from: { name: "Sam Ortiz", email: "sam@example.org" },
      text: "Can I get a refund?",
      sentAt: "2026-03-04T08:00:00.000Z",
    });
  });

  test("skips removed items and drafts", () => {
    expect(mapGraphMessage({ id: "x", "@removed": { reason: "deleted" } })).toBeNull();
    expect(mapGraphMessage({ ...sample, isDraft: true })).toBeNull();
  });
});

describe("MicrosoftProvider", () => {
  test("follows delta pages for inbox and sent items and stores both delta links", async () => {
    const requested: string[] = [];
    const fetcher = async (url: string) => {
      requested.push(url);
      if (url.includes("/inbox/") && !url.includes("page2")) {
        return Response.json({ value: [sample], "@odata.nextLink": "https://graph.microsoft.com/v1.0/inbox/page2" });
      }
      if (url.includes("page2")) return Response.json({ value: [], "@odata.deltaLink": "https://graph/inbox-delta" });
      return Response.json({ value: [], "@odata.deltaLink": "https://graph/sent-delta" });
    };
    const provider = new MicrosoftProvider("help@shop.test", async () => "t", fetcher, () => Date.parse("2026-03-15T00:00:00Z"));
    const first = await provider.pull(null);
    expect(first.messages).toHaveLength(1);
    expect(JSON.parse(first.cursor)).toEqual({ inbox: "https://graph/inbox-delta", sentitems: "https://graph/sent-delta" });
    expect(decodeURIComponent(requested[0]!)).toContain("receivedDateTime ge 2026-03-01T00:00:00.000Z");

    requested.length = 0;
    await provider.pull(first.cursor);
    expect(requested).toEqual(["https://graph/inbox-delta", "https://graph/sent-delta"]);
  });

  test("replies with createReply, then patches and sends the draft", async () => {
    const calls: string[] = [];
    const fetcher = async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method} ${url.replace("https://graph.microsoft.com/v1.0", "")}`);
      if (url.endsWith("/createReply")) return Response.json({ id: "draft-1", conversationId: "conv-1", internetMessageId: "<d1@x>" });
      if (url.endsWith("/send")) return new Response(null, { status: 202 });
      return Response.json({});
    };
    const provider = new MicrosoftProvider("help@shop.test", async () => "t", fetcher);
    const sent = await provider.send({
      from: { name: "Support", email: "help@shop.test" },
      to: [{ name: "Sam", email: "sam@example.org" }],
      cc: [],
      bcc: [],
      subject: "Re: Refund question",
      text: "Yes",
      html: "<p>Yes</p>",
      messageIdHeader: "<r@x>",
      replyToExternalId: "AAMk1",
    });
    expect(calls).toEqual(["POST /me/messages/AAMk1/createReply", "PATCH /me/messages/draft-1", "POST /me/messages/draft-1/send"]);
    expect(sent).toEqual({ externalId: "draft-1", messageIdHeader: "<d1@x>", threadHint: "conv-1" });
  });
});
