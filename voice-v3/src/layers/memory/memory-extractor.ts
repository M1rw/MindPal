import { LocalMemoryStore, type LocalMemoryRecord } from "./local-memory-store";

export type MemoryExtraction = {
  readonly keyFacts: readonly string[];
  readonly preferences: readonly string[];
};

export type MemoryExtractorEvent =
  | { readonly type: "memory.fact.extracted"; readonly keyFactCount: number; readonly preferenceCount: number }
  | { readonly type: "memory.context.injected"; readonly keyFactCount: number; readonly preferenceCount: number; readonly characterCount: number };

export type MemoryExtractorOptions = {
  readonly store: LocalMemoryStore;
  readonly enabled?: boolean;
  readonly incognito?: boolean;
  readonly onEvent?: (event: MemoryExtractorEvent) => void;
};

export type MemoryContext = {
  readonly record: LocalMemoryRecord;
  readonly text: string | null;
};

/** Local-only, high-confidence extraction. Raw input is never persisted or emitted. */
export class MemoryExtractor {
  private readonly store: LocalMemoryStore;
  private readonly enabled: boolean;
  private readonly incognito: boolean;
  private readonly onEvent: ((event: MemoryExtractorEvent) => void) | undefined;
  private extractionCountValue = 0;

  public constructor(options: MemoryExtractorOptions) {
    this.store = options.store;
    this.enabled = options.enabled ?? true;
    this.incognito = options.incognito ?? false;
    this.onEvent = options.onEvent;
  }

  public get extractionCount(): number {
    return this.extractionCountValue;
  }

  public extract(text: string): MemoryExtraction {
    if (!this.enabled || this.incognito) return { keyFacts: [], preferences: [] };
    const normalized = text.trim().slice(0, 4_000);
    if (!normalized) return { keyFacts: [], preferences: [] };
    const keyFacts: string[] = [];
    const preferences: string[] = [];
    capture(normalized, /\bmy\s+name\s+is\s+([^.!?\n]{1,80})/iu, (value) => keyFacts.push(`User name is ${value}.`));
    capture(normalized, /\bi\s+work\s+at\s+([^.!?\n]{1,100})/iu, (value) => keyFacts.push(`Works at ${value}.`));
    capture(normalized, /\bi\s+(?:am|'m)\s+building\s+([^.!?\n]{1,120})/iu, (value) => keyFacts.push(`Working on ${value}.`));
    capture(normalized, /\bi\s+prefer\s+([^.!?\n]{1,100})/iu, (value) => preferences.push(`Prefers ${value}.`));
    capture(normalized, /\bi\s+do\s+not\s+like\s+([^.!?\n]{1,100})/iu, (value) => preferences.push(`Dislikes ${value}.`));
    capture(normalized, /\bi\s+don't\s+like\s+([^.!?\n]{1,100})/iu, (value) => preferences.push(`Dislikes ${value}.`));
    return dedupeExtraction({ keyFacts, preferences });
  }

  public async processTurnComplete(finalUserTranscript: string): Promise<MemoryExtraction> {
    if (!this.enabled || this.incognito) return { keyFacts: [], preferences: [] };
    const extraction = this.extract(finalUserTranscript);
    if (extraction.keyFacts.length === 0 && extraction.preferences.length === 0) return extraction;
    await this.store.append(extraction.keyFacts, extraction.preferences);
    this.extractionCountValue += extraction.keyFacts.length + extraction.preferences.length;
    this.onEvent?.({
      type: "memory.fact.extracted",
      keyFactCount: extraction.keyFacts.length,
      preferenceCount: extraction.preferences.length,
    });
    return extraction;
  }

  public async buildContext(): Promise<MemoryContext> {
    const record = await this.store.get();
    if (!this.enabled || this.incognito || (record.keyFacts.length === 0 && record.preferences.length === 0)) {
      return { record, text: null };
    }
    const items = [...record.keyFacts.slice(-5), ...record.preferences.slice(-5)];
    const lines: string[] = [];
    let text = "User context from previous sessions:\n";
    for (const item of items) {
      const candidate = `${text}- ${item}\n`;
      if (candidate.length > 500) break;
      text = candidate;
      lines.push(item);
    }
    const bounded = lines.length > 0 ? text.trimEnd() : null;
    if (bounded) {
      this.onEvent?.({
        type: "memory.context.injected",
        keyFactCount: Math.min(record.keyFacts.length, 5),
        preferenceCount: Math.min(record.preferences.length, 5),
        characterCount: bounded.length,
      });
    }
    return { record, text: bounded };
  }

  public async clear(): Promise<void> {
    await this.store.clear();
    this.extractionCountValue = 0;
  }
}

function capture(text: string, pattern: RegExp, emit: (value: string) => void): void {
  const match = pattern.exec(text);
  const value = normalizeValue(match?.[1]);
  if (value) emit(value);
}

function normalizeValue(value: string | undefined): string {
  return (value ?? "")
    .replace(/[\s]+/gu, " ")
    .replace(/\s+(?:please|thanks|thank you)$/iu, "")
    .trim()
    .slice(0, 120);
}

function dedupeExtraction(extraction: MemoryExtraction): MemoryExtraction {
  return {
    keyFacts: [...new Set(extraction.keyFacts)],
    preferences: [...new Set(extraction.preferences)],
  };
}
