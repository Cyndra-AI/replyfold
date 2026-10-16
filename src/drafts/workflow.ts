import type { ModelProvider, ModelRequest } from "../ai/model";
import type { Draft, DraftAnalysis } from "../core/types";
import type { Store } from "../db/store";
import { analysisPrompt, buildPacket, draftPrompt, SYSTEM } from "./prompts";
import { AnalysisSchema, DraftOutputSchema } from "./schemas";
import { validateDraft } from "./validate";

const ATTEMPTS = 2;

async function withRetry<T>(model: ModelProvider, request: ModelRequest<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    try {
      return await model.json(request);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/**
 * Two model calls (analyst, then writer) and the deterministic checks. The draft
 * row moves generating -> ready or failed. If a newer customer message retired the
 * draft while the model was running, the result is dropped.
 */
export async function generateDraft(input: { store: Store; model: ModelProvider; draftId: string; now?: () => Date }): Promise<Draft> {
  const { store, model, draftId } = input;
  const draft = store.draft(draftId);
  if (!draft) throw new Error(`Draft ${draftId} does not exist.`);
  const conversation = store.conversation(draft.conversationId);
  if (!conversation) throw new Error(`Conversation ${draft.conversationId} does not exist.`);
  if (draft.state !== "generating") store.updateDraft(draftId, { state: "generating", error: null });

  const packet = buildPacket({
    customer: conversation.customer,
    subject: conversation.subject,
    messages: store.messages(conversation.id),
    playbook: store.playbook()?.content ?? "",
    instruction: store.draftInstruction(draftId),
    currentTime: (input.now?.() ?? new Date()).toISOString(),
  });

  const stillWanted = () => store.draft(draftId)?.state === "generating";

  try {
    const analysis: DraftAnalysis = await withRetry(model, { task: "analyze", system: SYSTEM, prompt: analysisPrompt(packet), schema: AnalysisSchema });
    if (!stillWanted()) return store.draft(draftId)!;
    store.updateConversation(conversation.id, { category: analysis.category });
    if (analysis.disposition === "no_reply") {
      return store.updateDraft(draftId, { state: "ready", body: "", analysis, issues: [], model: model.name })!;
    }
    const output = await withRetry(model, { task: "draft", system: SYSTEM, prompt: draftPrompt(packet, analysis), schema: DraftOutputSchema });
    if (!stillWanted()) return store.draft(draftId)!;
    const body = output.body.trim();
    const issues = validateDraft({ body, citations: output.citations, analysis, packet });
    return store.updateDraft(draftId, { state: "ready", body, analysis, issues, model: model.name, error: null })!;
  } catch (error) {
    if (!stillWanted()) return store.draft(draftId)!;
    const message = error instanceof Error ? error.message : String(error);
    return store.updateDraft(draftId, { state: "failed", error: message, model: model.name })!;
  }
}
