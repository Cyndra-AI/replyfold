import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const VERSION = "v1";

function keyFrom(secret: string) {
  if (secret.length < 16) throw new Error("REPLYFOLD_SECRET_KEY must be at least 16 characters.");
  return createHash("sha256").update(secret).digest();
}

/** AES-256-GCM sealed JSON. The key never leaves the server process. */
export class SecretBox {
  private readonly key: Buffer;

  constructor(secret: string) {
    this.key = keyFrom(secret);
  }

  seal(value: unknown): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return [VERSION, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), data.toString("base64url")].join(".");
  }

  open(sealed: string): unknown {
    const [version, iv, tag, data] = sealed.split(".");
    if (version !== VERSION || !iv || !tag || !data) throw new Error("Stored credentials are in an unknown format.");
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    try {
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8"));
    } catch {
      throw new Error("Stored credentials could not be decrypted. Check REPLYFOLD_SECRET_KEY.");
    }
  }
}

export function sha256(value: string) {
  return createHash("sha256").update(value).digest("base64url");
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}
