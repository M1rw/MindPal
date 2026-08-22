import { describe, expect, it } from "vitest";
import { LocalMemoryStore } from "./local-memory-store";
import { MemoryExtractor } from "./memory-extractor";

describe("MemoryExtractor", () => {
  it("extracts only explicit high-confidence statements", () => {
    const store = new LocalMemoryStore({ userId: "user-memory-extract" });
    const extractor = new MemoryExtractor({ store });
    expect(extractor.extract("My name is Marwan. I prefer TypeScript. I am building MindPal Voice V3. I don't like static audio assets.")).toEqual({
      keyFacts: ["User name is Marwan.", "Working on MindPal Voice V3."],
      preferences: ["Prefers TypeScript.", "Dislikes static audio assets."],
    });
    expect(extractor.extract("Maybe I like TypeScript, I think.")).toEqual({ keyFacts: [], preferences: [] });
  });

  it("bounds facts and preferences to the newest twenty entries", async () => {
    const store = new LocalMemoryStore({ userId: "user-memory-bounded" });
    await store.append(Array.from({ length: 25 }, (_, index) => `Fact ${index + 1}`), Array.from({ length: 25 }, (_, index) => `Preference ${index + 1}`));
    const record = await store.get();
    expect(record.keyFacts).toHaveLength(20);
    expect(record.preferences).toHaveLength(20);
    expect(record.keyFacts[0]).toBe("Fact 6");
    expect(record.preferences[0]).toBe("Preference 6");
  });

  it("builds a bounded context from at most five facts and five preferences", async () => {
    const store = new LocalMemoryStore({ userId: "user-memory-context" });
    await store.append(["User name is Marwan.", "Works at MindPal.", "Working on Voice V3.", "Uses TypeScript.", "Lives in Cairo.", "Extra fact."], ["Prefers concise answers.", "Prefers dark mode.", "Dislikes static audio assets.", "Prefers Arabic.", "Prefers tests.", "Extra preference."]);
    const context = await new MemoryExtractor({ store }).buildContext();
    expect(context.text).toContain("User context from previous sessions:");
    expect(context.text).not.toContain("User name is Marwan.");
    expect(context.text).toContain("Extra fact.");
    expect(context.text).toContain("Extra preference.");
    expect(context.text?.length ?? 0).toBeLessThanOrEqual(500);
  });

  it("does not extract or store when disabled or incognito", async () => {
    const disabledStore = new LocalMemoryStore({ userId: "user-memory-disabled" });
    const disabled = new MemoryExtractor({ store: disabledStore, enabled: false });
    await disabled.processTurnComplete("My name is Marwan.");
    expect((await disabledStore.get()).keyFacts).toEqual([]);

    const incognitoStore = new LocalMemoryStore({ userId: "user-memory-incognito" });
    const incognito = new MemoryExtractor({ store: incognitoStore, incognito: true });
    await incognito.processTurnComplete("My name is Marwan.");
    expect((await incognitoStore.get()).keyFacts).toEqual([]);
  });
});
