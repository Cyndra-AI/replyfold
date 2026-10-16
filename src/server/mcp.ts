import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Runtime } from "../runtime";
import { computeStats } from "../stats";

const PROTOCOL = "2025-06-18";

type Tool = {
  name: string;
  description: string;
  inputSchema: z.ZodType;
  run: (runtime: Runtime, input: unknown) => unknown;
};

const TOOLS: Tool[] = [
  {
    name: "list_conversations",
    description: "List inbox conversations. view is one of open, waiting, closed, unassigned or all. query filters by text.",
    inputSchema: z.object({ view: z.enum(["open", "waiting", "closed", "unassigned", "all"]).default("open"), query: z.string().default(""), limit: z.number().int().min(1).max(100).default(25) }),
    run: (runtime, input) => {
      const args = input as { view: "open"; query: string; limit: number };
      return runtime.store.listConversations({ view: args.view, query: args.query, limit: args.limit }).map((conversation) => ({
        id: conversation.id,
        subject: conversation.subject,
        customer: conversation.customer,
        status: conversation.status,
        category: conversation.category,
        lastMessageAt: conversation.lastMessageAt,
        draftState: runtime.store.currentDraft(conversation.id)?.state ?? null,
      }));
    },
  },
  {
    name: "get_conversation",
    description: "Read one conversation with its messages and the current AI draft.",
    inputSchema: z.object({ id: z.string() }),
    run: (runtime, input) => {
      const { id } = input as { id: string };
      const conversation = runtime.store.conversation(id);
      if (!conversation) throw new Error("No conversation with that id.");
      const draft = runtime.store.currentDraft(id);
      return {
        conversation,
        messages: runtime.store.messages(id).map((message) => ({ direction: message.direction, from: message.from, sentAt: message.sentAt, text: message.text })),
        draft: draft ? { state: draft.state, body: draft.body, issues: draft.issues, analysis: draft.analysis } : null,
      };
    },
  },
  {
    name: "get_statistics",
    description: "Reply volume, draft edit quality and first response time for the last N days.",
    inputSchema: z.object({ days: z.number().int().min(1).max(90).default(14) }),
    run: (runtime, input) => {
      const { days } = input as { days: number };
      const to = new Date();
      return computeStats(runtime.store, { from: new Date(to.getTime() - days * 86_400_000).toISOString(), to: to.toISOString() });
    },
  },
  {
    name: "get_playbook",
    description: "Read the current support playbook and pending suggestions.",
    inputSchema: z.object({}),
    run: (runtime) => ({ playbook: runtime.store.playbook()?.content ?? "", suggestions: runtime.store.suggestions("pending") }),
  },
];

const rpc = z.object({ jsonrpc: z.literal("2.0"), id: z.union([z.string(), z.number(), z.null()]).optional(), method: z.string(), params: z.unknown().optional() });

function tokenMatches(given: string, expected: string) {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Read-only Model Context Protocol endpoint over streamable HTTP, guarded by MCP_TOKEN. */
export async function handleMcp(request: Request, runtime: Runtime): Promise<Response> {
  const expected = runtime.config.mcpToken;
  if (!expected) return Response.json({ error: "Set MCP_TOKEN to turn on the MCP endpoint." }, { status: 503 });
  const given = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!tokenMatches(given, expected)) return Response.json({ error: "Invalid token." }, { status: 401 });
  if (request.method !== "POST") return new Response(null, { status: 405 });

  const parsed = rpc.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } });
  const { id = null, method, params } = parsed.data;
  if (id === null && method.startsWith("notifications/")) return new Response(null, { status: 202 });
  const reply = (result: unknown) => Response.json({ jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string) => Response.json({ jsonrpc: "2.0", id, error: { code, message } });

  switch (method) {
    case "initialize":
      return reply({ protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: "replyfold", version: "0.1.0" } });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: z.toJSONSchema(tool.inputSchema) })) });
    case "tools/call": {
      const call = z.object({ name: z.string(), arguments: z.unknown().optional() }).safeParse(params);
      const tool = call.success ? TOOLS.find((item) => item.name === call.data.name) : undefined;
      if (!call.success || !tool) return fail(-32602, "Unknown tool");
      const input = tool.inputSchema.safeParse(call.data.arguments ?? {});
      if (!input.success) return fail(-32602, input.error.issues[0]?.message ?? "Invalid arguments");
      try {
        return reply({ content: [{ type: "text", text: JSON.stringify(tool.run(runtime, input.data), null, 2) }] });
      } catch (error) {
        return reply({ isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Tool failed" }] });
      }
    }
    default:
      return fail(-32601, "Method not found");
  }
}
