import { describe, expect, test } from "bun:test";
import { classifyEdit, similarity } from "../../src/drafts/edits";

const draft = "Hello Dana, thanks for your message. Your order shipped on Monday and should arrive by Friday. Let us know if anything else comes up.";

describe("classifyEdit", () => {
  test("whitespace changes count as unchanged", () => {
    expect(classifyEdit(draft, `  ${draft.replace(". ", ".\n\n")} `)).toBe("unchanged");
  });

  test("a one-word fix is a light edit", () => {
    expect(classifyEdit(draft, draft.replace("Friday", "Thursday"))).toBe("light");
  });

  test("a rewrite is a heavy edit", () => {
    expect(classifyEdit(draft, "Hi Dana, we are sending a replacement today and refunding the shipping cost.")).toBe("heavy");
  });
});

describe("similarity", () => {
  test("is 1 for equal text and 0 against empty text", () => {
    expect(similarity("a b c", "a b c")).toBe(1);
    expect(similarity("a b c", "")).toBe(0);
    expect(similarity("a b c d", "a x c d")).toBe(0.75);
  });
});
