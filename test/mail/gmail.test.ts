import { describe, expect, test } from "bun:test";
import { GmailProvider, mapGmailMessage, type GmailMessage } from "../../src/mail/gmail";
import { SendRejectedError } from "../../src/mail/provider";

const b64 = (value: string) => Buffer.from(value).toString("base64url");

function gmailMessage(id: string, overrides: Partial<GmailMessage> = {}): GmailMessage {
  return {
    id,
    threadId: "thread-1",
    internalDate: String(Date.parse("2026-03-01T10:00:00Z")),
    labelIds: ["INBOX"],
    payload: {
      mimeType: "multipart/mixed",
      headers: [
        { name: "From", value: "Dana Lee <dana@example.com>" },
        { name: "To", value: "help@shop.test" },
        { name: "Subject", value: "Order late" },
        { name: "Message-ID", value: `<${id}@mail.test>` },
        { name: "References", value: "<a@x> <b@x>" },
      ],
      parts: [
        { mimeType: "text/plain", body: { data: b64("Where is it?") } },
        { mimeType: "image/png", filename: "box.png", body: { attachmentId: "att-1", size: 10 } },
      ],
    },
    ...overrides,
  };
}

describe("mapGmailMessage", () => {
  test("reads headers, the plain body and attachment references", () => {
    const mapped = mapGmailMessage(gmailMessage("m1"))!;
    expect(mapped.message).toMatchObject({
      externalId: "m1",
      threadHint: "thread-1",
      from: { name: "Dana Lee", email: "dana@example.com" },
      subject: "Order late",
      text: "Where is it?",
      references: ["<a@x>", "<b@x>"],
      sentAt: "2026-03-01T10:00:00.000Z",
    });
    expect(mapped.attachmentRefs).toEqual([{ id: "att-1", filename: "box.png", mimeType: "image/png" }]);
  });

  test("falls back to the HTML body as text", () => {
    const message = gmailMessage("m2");
    message.payload!.parts = [{ mimeType: "text/html", body: { data: b64("<p>Hi <b>there</b></p>") } }];
    expect(mapGmailMessage(message)?.message.text).toBe("Hi there");
  });

  test("skips drafts and spam", () => {
    expect(mapGmailMessage(gmailMessage("m3", { labelIds: ["DRAFT"] }))).toBeNull();
    expect(mapGmailMessage(gmailMessage("m4", { labelIds: ["SPAM"] }))).toBeNull();
  });
});

function router(routes: Array<[RegExp, (init?: RequestInit) => Response]>) {
  const calls: string[] = [];
  const fetcher = async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${url.replace("https://gmail.googleapis.com/gmail/v1/users/me", "")}`);
    const route = routes.find(([pattern]) => pattern.test(url));
    return route ? route[1](init) : new Response("missing", { status: 500 });
  };
  return { calls, fetcher };
}

describe("GmailProvider", () => {
  test("first sync lists recent mail and stores the profile history id", async () => {
    const { fetcher } = router([
      [/\/profile$/, () => Response.json({ historyId: "900" })],
      [/\/messages\?/, () => Response.json({ messages: [{ id: "m1" }] })],
      [/\/messages\/m1\/attachments\/att-1$/, () => Response.json({ data: b64("PNGDATA") })],
      [/\/messages\/m1\?format=full$/, () => Response.json(gmailMessage("m1"))],
    ]);
    const provider = new GmailProvider("help@shop.test", async () => "token", fetcher);
    const result = await provider.pull(null);
    expect(result.cursor).toBe("900");
    expect(result.messages).toHaveLength(1);
    expect(Buffer.from(result.messages[0]!.attachments[0]!.content).toString()).toBe("PNGDATA");
  });

  test("incremental sync reads history and falls back to a full sync when it expired", async () => {
    const { fetcher, calls } = router([
      [/\/history\?/, () => new Response("gone", { status: 404 })],
      [/\/profile$/, () => Response.json({ historyId: "950" })],
      [/\/messages\?/, () => Response.json({})],
    ]);
    const provider = new GmailProvider("help@shop.test", async () => "token", fetcher);
    const result = await provider.pull("100");
    expect(result).toEqual({ messages: [], cursor: "950" });
    expect(calls[0]).toStartWith("GET /history?startHistoryId=100");
  });

  test("sends raw MIME in the thread and reports a refusal as a rejection", async () => {
    let sentBody: { raw: string; threadId?: string } | undefined;
    const ok = router([
      [/\/messages\/send$/, (init) => {
        sentBody = JSON.parse(String(init?.body));
        return Response.json({ id: "sent-1", threadId: "thread-1" });
      }],
    ]);
    const provider = new GmailProvider("help@shop.test", async () => "token", ok.fetcher);
    const mail = {
      from: { name: "Support", email: "help@shop.test" },
      to: [{ name: "Dana", email: "dana@example.com" }],
      cc: [],
      bcc: [],
      subject: "Re: Order late",
      text: "On its way",
      html: "<p>On its way</p>",
      messageIdHeader: "<r1@shop.test>",
      threadHint: "thread-1",
    };
    expect(await provider.send(mail)).toEqual({ externalId: "sent-1", messageIdHeader: "<r1@shop.test>", threadHint: "thread-1" });
    expect(sentBody?.threadId).toBe("thread-1");
    expect(Buffer.from(sentBody!.raw, "base64url").toString()).toContain("Subject: Re: Order late");

    const refused = router([[/\/messages\/send$/, () => new Response("bad", { status: 400 })]]);
    const failing = new GmailProvider("help@shop.test", async () => "token", refused.fetcher);
    await expect(failing.send(mail)).rejects.toBeInstanceOf(SendRejectedError);
  });
});
