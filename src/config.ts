import { z } from "zod";

const flag = z
  .string()
  .optional()
  .transform((value) => ["1", "true", "yes", "on"].includes((value ?? "").toLowerCase()));

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  PUBLIC_URL: z.string().url().optional(),
  DATABASE_PATH: z.string().default("data/replyfold.sqlite"),
  REPLYFOLD_SECRET_KEY: z.string().optional(),
  REPLYFOLD_DEMO: flag,
  MODEL_PROVIDER: z.enum(["codex", "openai", "demo"]).optional(),
  CODEX_MODEL: z.string().optional(),
  CODEX_BIN: z.string().optional(),
  OPENAI_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  OPENAI_API_KEY: z.string().default(""),
  OPENAI_MODEL: z.string().default(""),
  GOOGLE_CLIENT_ID: z.string().default(""),
  GOOGLE_CLIENT_SECRET: z.string().default(""),
  MICROSOFT_CLIENT_ID: z.string().default(""),
  MICROSOFT_CLIENT_SECRET: z.string().default(""),
  MICROSOFT_TENANT: z.string().default("common"),
  SYNC_INTERVAL_SECONDS: z.coerce.number().int().min(15).default(60),
  MCP_TOKEN: z.string().default(""),
});

export type Config = {
  port: number;
  publicUrl: string;
  databasePath: string;
  secretKey: string;
  demo: boolean;
  model:
    | { kind: "codex"; model?: string; binary?: string }
    | { kind: "openai"; baseUrl: string; apiKey: string; model: string }
    | { kind: "demo" };
  oauth: {
    gmail: { clientId: string; clientSecret: string };
    microsoft: { clientId: string; clientSecret: string; tenant: string };
  };
  syncIntervalMs: number;
  mcpToken: string;
};

const DEMO_KEY = "demo-mode-key-not-for-real-mail";

export function readConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = EnvSchema.parse(env);
  const demo = parsed.REPLYFOLD_DEMO;
  const secretKey = parsed.REPLYFOLD_SECRET_KEY || (demo ? DEMO_KEY : "");
  if (secretKey.length < 16) {
    throw new Error("Set REPLYFOLD_SECRET_KEY to a random string of at least 16 characters. Run `openssl rand -base64 32` to make one.");
  }
  const kind = parsed.MODEL_PROVIDER ?? (demo ? "demo" : "codex");
  if (kind === "openai" && !parsed.OPENAI_MODEL) throw new Error("Set OPENAI_MODEL when MODEL_PROVIDER=openai.");
  const model: Config["model"] =
    kind === "openai"
      ? { kind, baseUrl: parsed.OPENAI_BASE_URL, apiKey: parsed.OPENAI_API_KEY, model: parsed.OPENAI_MODEL }
      : kind === "codex"
        ? { kind, model: parsed.CODEX_MODEL, binary: parsed.CODEX_BIN }
        : { kind };
  return {
    port: parsed.PORT,
    publicUrl: (parsed.PUBLIC_URL ?? `http://localhost:${parsed.PORT}`).replace(/\/$/, ""),
    databasePath: demo && !env.DATABASE_PATH ? ":memory:" : parsed.DATABASE_PATH,
    secretKey,
    demo,
    model,
    oauth: {
      gmail: { clientId: parsed.GOOGLE_CLIENT_ID, clientSecret: parsed.GOOGLE_CLIENT_SECRET },
      microsoft: { clientId: parsed.MICROSOFT_CLIENT_ID, clientSecret: parsed.MICROSOFT_CLIENT_SECRET, tenant: parsed.MICROSOFT_TENANT },
    },
    syncIntervalMs: parsed.SYNC_INTERVAL_SECONDS * 1000,
    mcpToken: parsed.MCP_TOKEN,
  };
}
