import type { ModelProvider } from "../ai/model";
import type { Lesson, PlaybookVersion } from "../core/types";
import type { Store } from "../db/store";
import { lessonPrompt, SYSTEM } from "./prompts";
import { LessonSchema } from "./schemas";

/**
 * After a heavy edit, one model call names what the draft got wrong. A lesson that
 * generalizes becomes a pending playbook suggestion. Nothing reaches the playbook
 * until an owner or lead accepts it.
 */
export async function learnFromEdit(input: { store: Store; model: ModelProvider; draftId: string }): Promise<Lesson | null> {
  const { store, model } = input;
  const draft = store.draft(input.draftId);
  if (!draft || draft.state !== "sent" || draft.editClass !== "heavy" || !draft.sentBody || !draft.body) return null;
  const playbook = store.playbook()?.content ?? "";
  const result = await model.json({
    task: "lesson",
    system: SYSTEM,
    prompt: lessonPrompt({ draft: draft.body, sent: draft.sentBody, playbook }),
    schema: LessonSchema,
  });
  const lesson = store.addLesson({ draftId: draft.id, category: result.category, summary: result.summary, rule: result.rule });
  const rule = result.rule.trim();
  if (result.generalizes && rule && !playbook.toLowerCase().includes(rule.toLowerCase())) {
    store.addSuggestion({ rule, rationale: result.summary, lessonIds: [lesson.id] });
  }
  return lesson;
}

export function acceptSuggestion(input: { store: Store; suggestionId: string; userId: string }): PlaybookVersion {
  const { store } = input;
  const suggestion = store.suggestions().find((item) => item.id === input.suggestionId);
  if (!suggestion || suggestion.state !== "pending") throw new Error("This suggestion was already handled.");
  const current = store.playbook()?.content.trimEnd() ?? "";
  const heading = "## Learned from edits";
  const content = current.includes(heading) ? `${current}\n- ${suggestion.rule}\n` : `${current}\n\n${heading}\n\n- ${suggestion.rule}\n`;
  return store.transaction(() => {
    store.setSuggestionState(suggestion.id, "accepted");
    return store.savePlaybook(content.trimStart(), "Accepted a suggestion from edits", input.userId);
  });
}
