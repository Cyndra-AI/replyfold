import { describe, expect, test } from "bun:test";
import type { DraftAnalysis } from "../../src/core/types";
import type { CasePacket } from "../../src/drafts/prompts";
import { validateDraft } from "../../src/drafts/validate";

const packet: CasePacket = {
  customer: { name: "Dana Lee", email: "dana@example.com" },
  subject: "Order late",
  evidence: [
    { id: "m1", author: "customer", name: "Dana", sentAt: "2026-03-01T10:00:00Z", subject: "Order late", text: "Track it at https://track.example.com/abc please" },
  ],
  playbook: "Our help center is https://help.example.com/returns",
  instruction: "",
  currentTime: "2026-03-02T10:00:00Z",
};

const analysis: DraftAnalysis = {
  summary: "Late order.",
  intent: "Wants status",
  category: "shipping",
  disposition: "reply",
  needsHuman: false,
  missingInformation: [],
  facts: [{ claim: "Order is late", evidence: ["m1"] }],
  confidence: 0.8,
};

const codes = (body: string, citations: string[] = ["m1"], overrides: Partial<DraftAnalysis> = {}) =>
  validateDraft({ body, citations, analysis: { ...analysis, ...overrides }, packet }).map((issue) => issue.code);

describe("validateDraft", () => {
  test("accepts a plain grounded reply", () => {
    expect(codes("Hello Dana,\n\nThanks for writing. Your order is on its way: https://track.example.com/abc")).toEqual([]);
  });

  test("flags links that appear nowhere in the thread or playbook", () => {
    expect(codes("See https://evil.example.net/x for details.")).toContain("unsourced_link");
    expect(codes("Our returns page: https://help.example.com/returns")).toEqual([]);
  });

  test("flags citations of messages that do not exist", () => {
    expect(codes("Hello Dana, it shipped.", ["m9"])).toContain("unknown_citation");
    expect(codes("Hello Dana, it shipped.", ["m1"], { facts: [{ claim: "x", evidence: ["m7"] }] })).toContain("unknown_citation");
  });

  test("flags unfilled placeholders and internal wording", () => {
    expect(codes("Hello [Customer Name], your order {order_number} shipped.")).toContain("placeholder");
    expect(codes("Hello Dana, per our playbook the evidence shows it shipped.")).toContain("internal_language");
    expect(codes("Hello Dana, as an AI language model I think it shipped.")).toContain("internal_language");
  });

  test("flags raw timestamps and empty or overlong replies", () => {
    expect(codes("Hello Dana, it ships 2026-03-04T10:00:00Z.")).toContain("raw_timestamp");
    expect(codes("   ")).toContain("empty");
    expect(codes(`Hello ${"word ".repeat(700)}`)).toContain("too_long");
  });

  test("carries a needs-human analysis into a visible issue", () => {
    expect(codes("Hello Dana, we will check.", ["m1"], { needsHuman: true })).toContain("needs_human");
  });
});
