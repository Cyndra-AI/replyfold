import type { ModelProvider, ModelRequest } from "../ai/model";
import type { Category } from "../core/types";

type Case = {
  match: RegExp;
  category: Category;
  intent: string;
  needsHuman?: boolean;
  missing?: string[];
  confidence: number;
  reply: string;
  noReply?: boolean;
};

/** Canned reasoning for demo mode. It reads the latest customer message and picks the first matching case. */
const CASES: Case[] = [
  {
    match: /charged twice|two charges|double charge/i,
    category: "billing",
    intent: "Refund a duplicate charge",
    needsHuman: true,
    confidence: 0.64,
    reply:
      "Thank you for letting us know, and I am sorry for the worry. We are checking the payment record for order #{order} now. If there are two charges, we will refund the extra one and email you as soon as it is issued.",
  },
  {
    match: /crack|broken|chip|damaged/i,
    category: "returns",
    intent: "Replace an item that arrived damaged",
    confidence: 0.88,
    reply:
      "Thank you for writing, and I am sorry your bowl arrived cracked. We will send a free replacement, and you do not need to send the broken one back. Could you reply with one photo of the bowl and the box? It helps us improve our packing.",
  },
  {
    match: /label created|not here|has not arrived|still not|tracking/i,
    category: "shipping",
    intent: "Find a late order before a deadline",
    confidence: 0.81,
    reply:
      "Thank you for writing, and I am sorry the tracking has not moved. Six days on \"label created\" means the parcel has not been scanned by the carrier. Because you need it by Saturday, we can send a replacement by express today at no cost, or refund the order in full. Which would you prefer?",
  },
  {
    match: /refund/i,
    category: "billing",
    intent: "Confirm a refund that has not arrived",
    missing: ["The date the refund was issued"],
    confidence: 0.58,
    reply:
      "Thank you for following up, and I am sorry for the wait. We are checking when your refund was issued and will send you the confirmation today.",
  },
  {
    match: /return|different colou?r/i,
    category: "returns",
    intent: "Ask who pays return shipping for a colour mismatch",
    confidence: 0.77,
    reply:
      "Thank you for starting the return. Since the napkins do not match the photo, that is our mistake, so we will cover the return shipping. We will email you a prepaid label within one business day.",
  },
  {
    match: /address/i,
    category: "shipping",
    intent: "Change the delivery address before shipping",
    confidence: 0.84,
    reply:
      "Thank you for letting us know so quickly. Your order has not shipped yet, so we have updated the delivery address to 18 Alder Lane, Portland. You will get a tracking email when it leaves our studio.",
  },
  {
    match: /wholesale|cafe|bulk/i,
    category: "product",
    intent: "Ask about wholesale pricing",
    needsHuman: true,
    missing: ["Wholesale price list"],
    confidence: 0.55,
    reply:
      "Thank you for thinking of us for your cafe. We do make larger orders. Could you tell us which cup size you want and when you need them? We will reply with pricing and lead time.",
  },
  {
    match: /dishwasher|microwave/i,
    category: "product",
    intent: "Product care question",
    confidence: 0.9,
    reply:
      "Thank you for asking. Our speckled plates are glazed stoneware and are safe in the dishwasher and the microwave. Hand washing keeps the speckles bright for longer.",
  },
  {
    match: /express|canada|toronto/i,
    category: "shipping",
    intent: "International express delivery timing",
    confidence: 0.72,
    reply:
      "Thank you for writing. We ship express to Canada, and it usually takes 2 to 4 business days. If you order by Monday, the planter should reach Toronto before next Friday.",
  },
  {
    match: /thank|love|made my week/i,
    category: "feedback",
    intent: "Share positive feedback",
    confidence: 0.95,
    reply: "Thank you so much for telling us. We will pass your note to the studio team. It really does make our week too.",
  },
];

const FALLBACK: Case = {
  match: /./,
  category: "other",
  intent: "General question",
  confidence: 0.6,
  reply: "Thank you for your message. We are looking into it and will reply with the details shortly.",
};

function packetOf(prompt: string) {
  const match = /<CONVERSATION>\n([\s\S]*?)\n<\/CONVERSATION>/.exec(prompt);
  if (!match) return null;
  return JSON.parse(match[1]!) as {
    customer: { name: string };
    messages: Array<{ id: string; author: string; text: string }>;
  };
}

function caseFor(text: string) {
  return CASES.find((item) => item.match.test(text)) ?? FALLBACK;
}

export class DemoModel implements ModelProvider {
  readonly name = "demo";

  async json<T>(request: ModelRequest<T>): Promise<T> {
    if (request.task === "lesson") {
      return request.schema.parse({
        generalizes: true,
        category: "policy",
        summary: "The team replaced the draft's request with a direct fix.",
        rule: "When we made the mistake, fix it first and ask for details second.",
      });
    }
    const packet = packetOf(request.prompt);
    const latest = [...(packet?.messages ?? [])].reverse().find((message) => message.author === "customer");
    const chosen = caseFor(latest?.text ?? "");
    const first = packet?.customer.name.split(" ")[0] ?? "";
    const order = /#?(\d{4})/.exec(latest?.text ?? "")?.[1] ?? "";
    if (request.task === "assist") {
      const reply = /<REPLY>\n([\s\S]*?)\n<\/REPLY>/.exec(request.prompt)?.[1] ?? "";
      const summary = `- ${chosen.intent}.\n- Latest message from ${first || "the customer"}.\n- ${chosen.needsHuman ? "Needs a person's decision." : "Ready for a reply."}`;
      return request.schema.parse({ text: request.prompt.startsWith("Summarize") ? summary : reply.replace(/\bThank you\b/, "Thanks") });
    }
    if (request.task === "analyze") {
      return request.schema.parse({
        summary: `${packet?.customer.name ?? "The customer"} wrote about: ${chosen.intent.toLowerCase()}.`,
        intent: chosen.intent,
        category: chosen.category,
        disposition: chosen.noReply ? "no_reply" : "reply",
        needsHuman: chosen.needsHuman ?? false,
        missingInformation: chosen.missing ?? [],
        facts: latest ? [{ claim: chosen.intent, evidence: [latest.id] }] : [],
        confidence: chosen.confidence,
      });
    }
    const greeting = first ? `Hello ${first},` : "Hello,";
    return request.schema.parse({
      body: `${greeting}\n\n${chosen.reply.replace("{order}", order)}`,
      citations: latest ? [latest.id] : [],
    });
  }
}
