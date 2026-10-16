import { describe, expect, test } from "bun:test";
import { SecretBox } from "../../src/core/secrets";

describe("SecretBox", () => {
  test("round-trips a value and hides it in the sealed text", () => {
    const box = new SecretBox("a-long-enough-test-key");
    const sealed = box.seal({ password: "app-password-123" });
    expect(sealed).not.toContain("app-password-123");
    expect(box.open(sealed)).toEqual({ password: "app-password-123" });
  });

  test("refuses to open with another key", () => {
    const sealed = new SecretBox("a-long-enough-test-key").seal({ a: 1 });
    expect(() => new SecretBox("another-long-test-key").open(sealed)).toThrow("could not be decrypted");
  });

  test("rejects a short key", () => {
    expect(() => new SecretBox("short")).toThrow("at least 16");
  });
});
