import type { DraftAnalysis, ValidationIssue } from "../core/types";
import type { CasePacket } from "./prompts";

const MAX_WORDS = 600;
const URL = /https?:\/\/[^\s<>"')\]]+/gi;
const PLACEHOLDER = /\[(?:customer|name|order|date|link|insert)[^\]]*\]|\{[a-z_ ]{2,30}\}|\bX{3,}\b|<(?:name|order)[^>]*>/i;
const INTERNAL = /\b(playbook|evidence ids?|as an ai|language model|the analyst|internal note|system prompt)\b/i;
const ISO_TIME = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

function trimUrl(url: string) {
  return url.replace(/[.,;:!?]+$/, "").toLowerCase();
}

type Rule = (input: { body: string; citations: string[]; analysis: DraftAnalysis; packet: CasePacket }) => ValidationIssue | null;

/**
 * Deterministic checks the server runs on every draft. They never block a person
 * from sending; they show what to look at before approving.
 */
const RULES: Rule[] = [
  ({ body }) => (body.trim() ? null : { code: "empty", message: "The draft is empty." }),
  ({ body }) =>
    body.split(/\s+/).filter(Boolean).length > MAX_WORDS
      ? { code: "too_long", message: `The draft is longer than ${MAX_WORDS} words.` }
      : null,
  ({ body, packet }) => {
    const known = new Set(
      [packet.playbook, ...packet.evidence.map((entry) => entry.text)].flatMap((text) => (text.match(URL) ?? []).map(trimUrl)),
    );
    const unknown = (body.match(URL) ?? []).map(trimUrl).filter((url) => !known.has(url));
    return unknown.length ? { code: "unsourced_link", message: `Check this link. It is not in the conversation or the playbook: ${unknown[0]}` } : null;
  },
  ({ citations, analysis, packet }) => {
    const ids = new Set(packet.evidence.map((entry) => entry.id));
    const cited = [...citations, ...analysis.facts.flatMap((fact) => fact.evidence)];
    const unknown = cited.filter((citation) => !ids.has(citation));
    return unknown.length ? { code: "unknown_citation", message: "The draft relies on a message that is not in this conversation." } : null;
  },
  ({ body }) => (PLACEHOLDER.test(body) ? { code: "placeholder", message: "The draft has a placeholder that was not filled in." } : null),
  ({ body }) => (INTERNAL.test(body) ? { code: "internal_language", message: "The draft mentions internal tools or process." } : null),
  ({ body }) => (ISO_TIME.test(body) ? { code: "raw_timestamp", message: "The draft has a raw timestamp. Use a plain date." } : null),
  ({ analysis }) =>
    analysis.needsHuman ? { code: "needs_human", message: "This case needs a person's judgment before it goes out." } : null,
  ({ analysis }) =>
    analysis.missingInformation.length
      ? { code: "missing_info", message: `Missing: ${analysis.missingInformation.slice(0, 3).join("; ")}` }
      : null,
];

export function validateDraft(input: { body: string; citations: string[]; analysis: DraftAnalysis; packet: CasePacket }): ValidationIssue[] {
  return RULES.map((rule) => rule(input)).filter((issue): issue is ValidationIssue => issue !== null);
}
