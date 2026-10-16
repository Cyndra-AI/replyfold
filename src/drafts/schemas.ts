import { z } from "zod";
import { CATEGORIES } from "../core/types";

export const AnalysisSchema = z.object({
  summary: z.string().min(1).max(600),
  intent: z.string().min(1).max(300),
  category: z.enum(CATEGORIES),
  disposition: z.enum(["reply", "no_reply"]),
  needsHuman: z.boolean(),
  missingInformation: z.array(z.string().max(300)).max(10),
  facts: z.array(z.object({ claim: z.string().max(400), evidence: z.array(z.string()).max(10) })).max(20),
  confidence: z.number().min(0).max(1),
});

export const DraftOutputSchema = z.object({
  body: z.string().max(8000),
  citations: z.array(z.string()).max(20),
});

export const LessonSchema = z.object({
  generalizes: z.boolean(),
  category: z.enum(["facts", "tone", "structure", "policy", "missing_info", "wording", "other"]),
  summary: z.string().max(400),
  rule: z.string().max(400),
});

export const ASSIST_TASKS = ["improve", "shorten", "warmer", "summarize"] as const;
export type AssistTask = (typeof ASSIST_TASKS)[number];

export const AssistSchema = z.object({ text: z.string().max(8000) });
