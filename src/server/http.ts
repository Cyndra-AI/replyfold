import { z } from "zod";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const json = (value: unknown, init: ResponseInit = {}) =>
  Response.json(value, { ...init, headers: { "cache-control": "no-store", ...init.headers } });

export async function body<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new HttpError(400, "The request body must be JSON.");
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new HttpError(400, issue ? `${issue.path.join(".") || "body"}: ${issue.message}` : "Invalid request.");
  }
  return parsed.data;
}

export function readCookie(request: Request, name: string) {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

/** Fixed-window counter, used to slow down password guessing. */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  allow(key: string, now = Date.now()) {
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      if (this.hits.size > 10_000) this.hits.clear();
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    entry.count += 1;
    return entry.count <= this.limit;
  }
}
