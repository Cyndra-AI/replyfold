import type { MailProvider, OutgoingMail, PulledMessage, PullResult, SentMail } from "../mail/provider";
import { DEMO_MAILBOX, DEMO_OPEN_THREADS } from "./fixtures";

/** A mailbox that holds the demo conversations and accepts every send without delivering it. */
export class DemoProvider implements MailProvider {
  readonly kind = "demo" as const;
  readonly address = DEMO_MAILBOX.address;

  constructor(private readonly now: () => number = Date.now) {}

  async pull(cursor: string | null): Promise<PullResult> {
    if (cursor) return { messages: [], cursor };
    const messages: PulledMessage[] = DEMO_OPEN_THREADS.flatMap((thread) =>
      thread.messages.map((message, index) => {
        const fromCustomer = message.from === "customer";
        const id = `${thread.hint}-${index}`;
        return {
          externalId: id,
          threadHint: thread.hint,
          messageIdHeader: `<${id}@demo.fernhill.example>`,
          inReplyTo: "",
          references: [],
          from: fromCustomer ? thread.customer : { name: DEMO_MAILBOX.displayName, email: DEMO_MAILBOX.address },
          to: fromCustomer ? [{ name: DEMO_MAILBOX.displayName, email: DEMO_MAILBOX.address }] : [thread.customer],
          cc: [],
          subject: index === 0 ? thread.subject : `Re: ${thread.subject}`,
          text: message.text,
          sentAt: new Date(this.now() - message.minutesAgo * 60_000).toISOString(),
          attachments: [],
        };
      }),
    );
    return { messages, cursor: "seeded" };
  }

  async send(mail: OutgoingMail): Promise<SentMail> {
    return { externalId: `demo-sent-${crypto.randomUUID()}`, messageIdHeader: mail.messageIdHeader, threadHint: mail.threadHint ?? null };
  }
}
