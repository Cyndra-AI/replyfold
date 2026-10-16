import { describe, expect, test } from "bun:test";
import { ImapProvider, parseRawMessage, type ImapSession } from "../../src/mail/imap";
import { SendRejectedError } from "../../src/mail/provider";

function raw(uid: number, extra = "") {
  return Buffer.from(
    [
      `From: "Ana Ruiz" <ana@example.net>`,
      `To: help@shop.test`,
      `Subject: Return label ${uid}`,
      `Message-ID: <u${uid}@example.net>`,
      `Date: Tue, 03 Mar 2026 09:00:00 +0000`,
      extra,
      `MIME-Version: 1.0`,
      `Content-Type: multipart/mixed; boundary="b"`,
      ``,
      `--b`,
      `Content-Type: text/plain; charset=UTF-8`,
      ``,
      `I need a return label.`,
      ``,
      `On Mon, Mar 2, 2026 Support wrote:`,
      `> earlier`,
      `--b`,
      `Content-Type: application/pdf; name="receipt.pdf"`,
      `Content-Disposition: attachment; filename="receipt.pdf"`,
      `Content-Transfer-Encoding: base64`,
      ``,
      Buffer.from("PDFDATA").toString("base64"),
      `--b--`,
      ``,
    ]
      .filter((line, index) => line !== "" || index > 6)
      .join("\r\n"),
  );
}

class FakeSession implements ImapSession {
  appended: string[] = [];
  closed = 0;
  constructor(private state: { uidValidity: string; uidNext: number; uids: number[] }) {}
  async openInbox() {
    return { uidValidity: this.state.uidValidity, uidNext: this.state.uidNext };
  }
  async searchSince() {
    return this.state.uids;
  }
  async *fetchSources(range: number[] | { from: number }) {
    const uids = Array.isArray(range) ? range : this.state.uids.filter((uid) => uid >= range.from);
    for (const uid of uids) yield { uid, source: raw(uid) };
  }
  async appendSent(message: string) {
    this.appended.push(message);
  }
  async close() {
    this.closed += 1;
  }
}

describe("parseRawMessage", () => {
  test("reads headers, text and attachments from raw mail", async () => {
    const message = await parseRawMessage(raw(7, "In-Reply-To: <a@shop.test>\r\nReferences: <z@shop.test> <a@shop.test>"), "1:7");
    expect(message).toMatchObject({
      externalId: "1:7",
      from: { name: "Ana Ruiz", email: "ana@example.net" },
      subject: "Return label 7",
      messageIdHeader: "<u7@example.net>",
      inReplyTo: "<a@shop.test>",
      references: ["<z@shop.test>", "<a@shop.test>"],
      sentAt: "2026-03-03T09:00:00.000Z",
    });
    expect(message.text).toContain("I need a return label.");
    expect(message.attachments.map((item) => item.filename)).toEqual(["receipt.pdf"]);
  });
});

describe("ImapProvider", () => {
  test("first sync searches recent mail, then resumes after the last uid", async () => {
    const session = new FakeSession({ uidValidity: "42", uidNext: 13, uids: [10, 12] });
    const provider = new ImapProvider("help@shop.test", async () => session, async () => {});
    const first = await provider.pull(null);
    expect(first.messages.map((item) => item.externalId)).toEqual(["42:10", "42:12"]);
    expect(JSON.parse(first.cursor)).toEqual({ uidValidity: "42", lastUid: 12 });

    const again = await provider.pull(first.cursor);
    expect(again.messages).toEqual([]);
    expect(session.closed).toBe(2);
  });

  test("starts over when the server resets UIDVALIDITY", async () => {
    const session = new FakeSession({ uidValidity: "43", uidNext: 3, uids: [2] });
    const provider = new ImapProvider("help@shop.test", async () => session, async () => {});
    const result = await provider.pull(JSON.stringify({ uidValidity: "42", lastUid: 99 }));
    expect(result.messages.map((item) => item.externalId)).toEqual(["43:2"]);
  });

  test("sends over SMTP to every recipient and files a copy in Sent", async () => {
    const session = new FakeSession({ uidValidity: "1", uidNext: 1, uids: [] });
    const envelopes: Array<{ from: string; to: string[] }> = [];
    const provider = new ImapProvider("help@shop.test", async () => session, async (envelope) => {
      envelopes.push(envelope);
    });
    await provider.send({
      from: { name: "Support", email: "help@shop.test" },
      to: [{ name: "Ana", email: "ana@example.net" }],
      cc: [{ name: "", email: "ops@shop.test" }],
      bcc: [],
      subject: "Re: Return label",
      text: "Attached",
      html: "<p>Attached</p>",
      messageIdHeader: "<s1@shop.test>",
    });
    expect(envelopes).toEqual([{ from: "help@shop.test", to: ["ana@example.net", "ops@shop.test"] }]);
    expect(session.appended[0]).toContain("Message-ID: <s1@shop.test>");
  });

  test("treats a permanent SMTP refusal as a rejection", async () => {
    const provider = new ImapProvider(
      "help@shop.test",
      async () => new FakeSession({ uidValidity: "1", uidNext: 1, uids: [] }),
      async () => {
        throw Object.assign(new Error("550 mailbox unavailable"), { responseCode: 550 });
      },
    );
    const mail = {
      from: { name: "", email: "help@shop.test" },
      to: [{ name: "", email: "x@example.net" }],
      cc: [],
      bcc: [],
      subject: "s",
      text: "t",
      html: "t",
      messageIdHeader: "<s2@shop.test>",
    };
    await expect(provider.send(mail)).rejects.toBeInstanceOf(SendRejectedError);
  });
});
