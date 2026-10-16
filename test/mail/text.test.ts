import { describe, expect, test } from "bun:test";
import { htmlToText, visibleText } from "../../src/mail/text";

describe("visibleText", () => {
  test("drops quoted history under an 'On ... wrote:' line", () => {
    const text = "Thanks, that worked.\n\nOn Mon, Mar 2, 2026 at 9:00 AM Support <help@shop.test> wrote:\n> Try again";
    expect(visibleText(text)).toBe("Thanks, that worked.");
  });

  test("drops an Outlook style header block", () => {
    const text = "Still waiting.\r\n\r\nFrom: Support <help@shop.test>\r\nSent: Monday\r\nSubject: Re: order";
    expect(visibleText(text)).toBe("Still waiting.");
  });

  test("keeps the whole text when it is all quote", () => {
    expect(visibleText("> only quoted")).toBe("> only quoted");
  });
});

describe("htmlToText", () => {
  test("turns markup into readable lines", () => {
    expect(htmlToText("<p>Hello&nbsp;Dana</p><p>Order <b>#1042</b> &amp; more</p><style>p{}</style>")).toBe(
      "Hello Dana\nOrder #1042 & more",
    );
  });
});
