import { describe, expect, test } from "bun:test";
import { buildMime, encodeHeader, formatAddress, parseAddressList, replySubject } from "../../src/mail/mime";

describe("parseAddressList", () => {
  test("reads names, bare addresses and quoted commas", () => {
    expect(parseAddressList('"Lee, Dana" <Dana@Example.com>, sam@example.org')).toEqual([
      { name: "Lee, Dana", email: "dana@example.com" },
      { name: "", email: "sam@example.org" },
    ]);
  });

  test("returns nothing for an empty header", () => {
    expect(parseAddressList("")).toEqual([]);
  });
});

describe("replySubject", () => {
  test("adds Re: once", () => {
    expect(replySubject("Order late")).toBe("Re: Order late");
    expect(replySubject("RE: Order late")).toBe("RE: Order late");
    expect(replySubject("  ")).toBe("Re: your message");
  });
});

describe("headers", () => {
  test("encodes non-ASCII text as an RFC 2047 word", () => {
    expect(encodeHeader("Plain")).toBe("Plain");
    expect(encodeHeader("Café")).toBe("=?UTF-8?B?Q2Fmw6k=?=");
  });

  test("quotes display names with punctuation", () => {
    expect(formatAddress({ name: "Lee, Dana", email: "dana@example.com" })).toBe('"Lee, Dana" <dana@example.com>');
    expect(formatAddress({ name: "", email: "dana@example.com" })).toBe("dana@example.com");
  });
});

describe("buildMime", () => {
  test("builds a threaded multipart reply with base64 parts", () => {
    const raw = buildMime({
      from: { name: "Support", email: "help@shop.test" },
      to: [{ name: "Dana", email: "dana@example.com" }],
      cc: [],
      bcc: [],
      subject: "Re: Order late",
      text: "Hello Dana",
      html: "<p>Hello Dana</p>",
      inReplyTo: "<a1@example.com>",
      references: ["<a0@example.com>", "<a1@example.com>"],
      messageIdHeader: "<r1@shop.test>",
      date: new Date("2026-01-02T03:04:05Z"),
      boundary: "b1",
    });
    expect(raw).toContain("From: Support <help@shop.test>\r\n");
    expect(raw).toContain("Message-ID: <r1@shop.test>\r\n");
    expect(raw).toContain("In-Reply-To: <a1@example.com>\r\n");
    expect(raw).toContain("References: <a0@example.com> <a1@example.com>\r\n");
    expect(raw).toContain('Content-Type: multipart/alternative; boundary="b1"');
    expect(raw).toContain(Buffer.from("Hello Dana").toString("base64"));
    expect(raw).not.toMatch(/[^\x00-\x7f]/);
  });

  test("strips header injection from addresses and subject", () => {
    const raw = buildMime({
      from: { name: "Support", email: "help@shop.test" },
      to: [{ name: "", email: "dana@example.com\r\nBcc: evil@example.com" }],
      cc: [],
      bcc: [],
      subject: "Hi\r\nBcc: evil@example.com",
      text: "x",
      html: "x",
      messageIdHeader: "<r2@shop.test>",
      boundary: "b2",
    });
    expect(raw).not.toContain("\r\nBcc:");
  });
});
