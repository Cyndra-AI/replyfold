/** Fictional shop, people and mail for demo mode and screenshots. Every address uses a reserved example domain. */

export const DEMO_MAILBOX = { address: "hello@fernhill.example", displayName: "Fernhill Support" };

export const DEMO_TEAM = [
  { email: "morgan@fernhill.example", name: "Morgan Avery", role: "owner" as const, signature: "Morgan\nFernhill Support" },
  { email: "priya@fernhill.example", name: "Priya Nair", role: "lead" as const, signature: "Priya\nFernhill Support" },
  { email: "jonas@fernhill.example", name: "Jonas Weber", role: "agent" as const, signature: "Jonas\nFernhill Support" },
  { email: "leah@fernhill.example", name: "Leah Okafor", role: "agent" as const, signature: "Leah\nFernhill Support" },
];

export const DEMO_PASSWORD = "fernhill-demo";

export const DEMO_PLAYBOOK = `# Fernhill support playbook

## Voice
- Greet the customer by first name. Thank them for writing.
- Short paragraphs. Plain words. No exclamation marks in bad news.
- Sign off is added by the app. Do not write one.

## Shipping
- Orders ship from our studio within 2 business days.
- Standard delivery takes 3 to 6 business days. Express takes 1 to 2.
- If tracking has not moved for 5 business days, offer a replacement or a full refund. Let the customer choose.

## Damaged or broken items
- Ask for one photo of the item and the box.
- Never ask the customer to send a broken item back.
- Offer a free replacement first. Offer a refund if they prefer.

## Returns
- Unused items can be returned within 30 days. Returns help: https://fernhill.example/returns
- We pay return shipping only for our mistakes.

## Billing
- Refunds go back to the original payment method within 5 to 10 business days.
- Never confirm a refund in an email before it is issued.
`;

type Thread = {
  hint: string;
  customer: { name: string; email: string };
  subject: string;
  messages: Array<{ from: "customer" | "team"; minutesAgo: number; text: string }>;
};

export const DEMO_OPEN_THREADS: Thread[] = [
  {
    hint: "t-1042",
    customer: { name: "Dana Lee", email: "dana.lee@example.com" },
    subject: "Order #1042 still not here",
    messages: [
      {
        from: "customer",
        minutesAgo: 14,
        text: "Hi Fernhill,\n\nI ordered the speckled mug set (order #1042) on the 2nd. Tracking has said \"label created\" for six days now. It is a birthday present for Saturday. Can you tell me what is going on?\n\nThanks,\nDana",
      },
    ],
  },
  {
    hint: "t-1051",
    customer: { name: "Sam Ortiz", email: "sam.ortiz@example.org" },
    subject: "Bowl arrived cracked",
    messages: [
      {
        from: "customer",
        minutesAgo: 38,
        text: "Hello, my serving bowl arrived today with a crack down the side. The box looked fine. Order 1051. What can you do?",
      },
    ],
  },
  {
    hint: "t-1033",
    customer: { name: "Ana Ruiz", email: "ana.ruiz@example.net" },
    subject: "Return for the linen napkins",
    messages: [
      { from: "customer", minutesAgo: 2900, text: "Hi, I would like to return the linen napkins from order 1033. They are unused. How do I do that?" },
      {
        from: "team",
        minutesAgo: 2700,
        text: "Hello Ana,\n\nThank you for writing. Unused items can be returned within 30 days. You can start the return here: https://fernhill.example/returns\n\nPriya\nFernhill Support",
      },
      { from: "customer", minutesAgo: 62, text: "Thanks Priya. I started it, but the page asks who pays shipping. The napkins are a different colour than the photo. Do I still pay?" },
    ],
  },
  {
    hint: "t-1060",
    customer: { name: "Wei Chen", email: "wei.chen@example.com" },
    subject: "Charged twice?",
    messages: [
      { from: "customer", minutesAgo: 95, text: "I see two charges of $64.00 on my card for one order (#1060). Can you check and refund one of them?" },
    ],
  },
  {
    hint: "t-1064",
    customer: { name: "Grace Mensah", email: "grace.m@example.org" },
    subject: "Wholesale question",
    messages: [
      { from: "customer", minutesAgo: 180, text: "Hi! I run a small cafe and would love to order 40 of your stoneware cups. Do you offer wholesale pricing?" },
    ],
  },
  {
    hint: "t-1066",
    customer: { name: "Tom Becker", email: "tom.becker@example.com" },
    subject: "Change delivery address",
    messages: [
      { from: "customer", minutesAgo: 240, text: "Hello, I just placed order 1066 and used my old address by mistake. Can you change it to 18 Alder Lane, Portland? Thank you." },
    ],
  },
  {
    hint: "t-1070",
    customer: { name: "Lina Haddad", email: "lina.h@example.net" },
    subject: "Love the vase",
    messages: [
      { from: "customer", minutesAgo: 320, text: "Just wanted to say the blue vase is even nicer in person. It made my week. Thank you!" },
    ],
  },
  {
    hint: "t-1072",
    customer: { name: "Marco Rossi", email: "marco.rossi@example.com" },
    subject: "Dishwasher safe?",
    messages: [
      { from: "customer", minutesAgo: 410, text: "Are the speckled plates dishwasher and microwave safe? I want to buy a set of six." },
    ],
  },
  {
    hint: "t-1074",
    customer: { name: "Hana Sato", email: "hana.sato@example.org" },
    subject: "Where is my refund",
    messages: [
      { from: "customer", minutesAgo: 4500, text: "I returned the teapot last week. When will I get my refund?" },
      {
        from: "team",
        minutesAgo: 4300,
        text: "Hello Hana,\n\nThank you for your patience. Your return reached our studio and the refund will go back to your card within 5 to 10 business days.\n\nJonas\nFernhill Support",
      },
      { from: "customer", minutesAgo: 520, text: "It has been 8 business days and I still do not see it. Can you send me a confirmation?" },
    ],
  },
  {
    hint: "t-1077",
    customer: { name: "Noah Fischer", email: "noah.f@example.com" },
    subject: "Express shipping to Canada",
    messages: [{ from: "customer", minutesAgo: 700, text: "Do you ship express to Toronto? I need the planter by next Friday." }],
  },
];

const HISTORY_SUBJECTS: Array<{ subject: string; ask: string; reply: string; edited?: string }> = [
  {
    subject: "Tracking number?",
    ask: "Could you send me the tracking number for my order?",
    reply: "Thank you for writing. Your order left our studio yesterday. The tracking link is in your shipping email, and the parcel should arrive in 3 to 6 business days.",
  },
  {
    subject: "Gift wrap",
    ask: "Can you gift wrap my order and add a note?",
    reply: "Thank you for your message. We can gift wrap it and add your note. Reply with the text you would like on the card.",
  },
  {
    subject: "Chipped plate",
    ask: "One plate in my set has a small chip on the rim.",
    reply: "I am sorry the plate arrived chipped. Please send one photo of the plate and the box, and we will ship a free replacement.",
    edited: "I am sorry the plate arrived chipped. We are sending a free replacement today, and you do not need to return the chipped one. A photo of the plate and the box helps us improve our packing.",
  },
  {
    subject: "Cancel my order",
    ask: "Please cancel my order, I ordered the wrong colour.",
    reply: "Thank you for letting us know. Your order has not shipped yet, so we have cancelled it. The refund goes back to your card within 5 to 10 business days.",
  },
  {
    subject: "Restock date",
    ask: "When will the large oat bowl be back in stock?",
    reply: "Thank you for asking. The large oat bowl is back in the kiln this month. We expect it in the shop in about three weeks.",
    edited: "Thanks for asking. The large oat bowl is in the kiln now and should be back in about three weeks. Want us to email you when it is live?",
  },
  {
    subject: "Discount code not working",
    ask: "My code SPRING10 is not working at checkout.",
    reply: "Thank you for your message. SPRING10 ended on Sunday. We are sorry for the confusion.",
    edited: "Thanks for your message. SPRING10 ended on Sunday, but we have honoured it on your order. You will see the 10% back on your card in a few days.",
  },
];

const HISTORY_CUSTOMERS = [
  "Olivia Grant",
  "Ethan Brooks",
  "Maya Patel",
  "Lucas Moreau",
  "Zoe Kim",
  "Arjun Rao",
  "Ella Novak",
  "Ben Carter",
  "Isla Murray",
  "Omar Aziz",
  "Chloe Martin",
  "Felix Wagner",
];

export type HistoryItem = {
  hint: string;
  customer: { name: string; email: string };
  subject: string;
  ask: string;
  draft: string;
  sent: string;
  daysAgo: number;
  minutesToReply: number;
  teammate: number;
};

/** Thirty closed conversations spread over the last two weeks, for statistics. */
export function demoHistory(): HistoryItem[] {
  return Array.from({ length: 30 }, (_, index) => {
    const template = HISTORY_SUBJECTS[index % HISTORY_SUBJECTS.length]!;
    const name = HISTORY_CUSTOMERS[index % HISTORY_CUSTOMERS.length]!;
    const first = name.split(" ")[0]!;
    const draft = `Hello ${first},\n\n${template.reply}`;
    const lightEdit = index % 4 === 1 ? draft.replace("Thank you", "Thanks") : draft;
    return {
      hint: `h-${index}`,
      customer: { name, email: `${name.toLowerCase().replace(/\s+/g, ".")}@example.com` },
      subject: template.subject,
      ask: template.ask,
      draft,
      sent: template.edited && index % 2 === 0 ? `Hello ${first},\n\n${template.edited}` : lightEdit,
      daysAgo: [1, 1, 2, 2, 2, 3, 4, 4, 5, 5, 5, 5, 6, 7, 8, 8, 8, 9, 10, 10, 11, 11, 11, 11, 12, 13, 13, 6, 3, 1][index]!,
      minutesToReply: 12 + ((index * 37) % 180),
      teammate: index % 4,
    };
  });
}
