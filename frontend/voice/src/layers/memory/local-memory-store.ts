export type LocalMemoryRecord = {
  readonly userId: string;
  readonly lastUpdated: number;
  readonly keyFacts: readonly string[];
  readonly preferences: readonly string[];
};

export type LocalMemoryStoreOptions = {
  readonly userId: string;
  readonly dbName?: string;
  readonly storeName?: string;
  readonly maxFacts?: number;
  readonly maxPreferences?: number;
  readonly indexedDB?: IDBFactory;
  readonly nowMs?: () => number;
};

const DEFAULT_DB_NAME = "mindpal-voice-v3";
const DEFAULT_STORE_NAME = "local-memory";
const FALLBACK_MEMORY = new Map<string, LocalMemoryRecord>();

/** Browser-local, bounded memory. It never accepts a raw transcript as storage input. */
export class LocalMemoryStore {
  private readonly userId: string;
  private readonly dbName: string;
  private readonly storeName: string;
  private readonly maxFacts: number;
  private readonly maxPreferences: number;
  private readonly indexedDB: IDBFactory | undefined;
  private readonly nowMs: () => number;
  private dbPromise: Promise<IDBDatabase> | null = null;

  public constructor(options: LocalMemoryStoreOptions) {
    this.userId = requireUserId(options.userId);
    this.dbName = options.dbName ?? DEFAULT_DB_NAME;
    this.storeName = options.storeName ?? DEFAULT_STORE_NAME;
    this.maxFacts = Math.max(1, options.maxFacts ?? 20);
    this.maxPreferences = Math.max(1, options.maxPreferences ?? 20);
    this.indexedDB = options.indexedDB ?? globalThis.indexedDB;
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  public async get(): Promise<LocalMemoryRecord> {
    if (!this.indexedDB) return cloneRecord(FALLBACK_MEMORY.get(this.userId) ?? emptyRecord(this.userId));
    const db = await this.open();
    return new Promise<LocalMemoryRecord>((resolve, reject) => {
      const request = db.transaction(this.storeName, "readonly").objectStore(this.storeName).get(this.userId);
      request.onsuccess = () => resolve(normalizeRecord(request.result, this.userId, this.maxFacts, this.maxPreferences));
      request.onerror = () => reject(request.error ?? new Error("local memory read failed"));
    });
  }

  public async append(keyFacts: readonly string[] = [], preferences: readonly string[] = []): Promise<LocalMemoryRecord> {
    const current = await this.get();
    const next = normalizeRecord({
      userId: this.userId,
      lastUpdated: this.nowMs(),
      keyFacts: appendUnique(current.keyFacts, keyFacts, this.maxFacts),
      preferences: appendUnique(current.preferences, preferences, this.maxPreferences),
    }, this.userId, this.maxFacts, this.maxPreferences);
    await this.put(next);
    return next;
  }

  public async put(record: LocalMemoryRecord): Promise<void> {
    const normalized = normalizeRecord(record, this.userId, this.maxFacts, this.maxPreferences);
    if (!this.indexedDB) {
      FALLBACK_MEMORY.set(this.userId, cloneRecord(normalized));
      return;
    }
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const request = db.transaction(this.storeName, "readwrite").objectStore(this.storeName).put(normalized);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? new Error("local memory write failed"));
    });
  }

  public async clear(): Promise<void> {
    if (!this.indexedDB) {
      FALLBACK_MEMORY.delete(this.userId);
      return;
    }
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const request = db.transaction(this.storeName, "readwrite").objectStore(this.storeName).delete(this.userId);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? new Error("local memory clear failed"));
    });
  }

  private open(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    const factory = this.indexedDB;
    if (!factory) return Promise.reject(new Error("IndexedDB unavailable"));
    this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(this.dbName, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(this.storeName)) {
          request.result.createObjectStore(this.storeName, { keyPath: "userId" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("local memory database open failed"));
    });
    return this.dbPromise;
  }
}

function emptyRecord(userId: string): LocalMemoryRecord {
  return { userId, lastUpdated: 0, keyFacts: [], preferences: [] };
}

function normalizeRecord(value: unknown, userId: string, maxFacts: number, maxPreferences: number): LocalMemoryRecord {
  const candidate = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
  return {
    userId,
    lastUpdated: typeof candidate.lastUpdated === "number" && Number.isFinite(candidate.lastUpdated) ? candidate.lastUpdated : 0,
    keyFacts: boundedStrings(candidate.keyFacts, maxFacts),
    preferences: boundedStrings(candidate.preferences, maxPreferences),
  };
}

function boundedStrings(value: unknown, max: number): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().slice(0, 160))
    .filter(Boolean)
    .slice(-max);
}

function appendUnique(existing: readonly string[], next: readonly string[], max: number): string[] {
  const output = [...existing];
  for (const item of next) {
    const normalized = item.trim().slice(0, 160);
    if (normalized && !output.includes(normalized)) output.push(normalized);
  }
  return output.slice(-max);
}

function cloneRecord(record: LocalMemoryRecord): LocalMemoryRecord {
  return { ...record, keyFacts: [...record.keyFacts], preferences: [...record.preferences] };
}

function requireUserId(value: string): string {
  const userId = value.trim();
  if (!userId || userId.length > 200) throw new Error("LocalMemoryStore requires a bounded userId");
  return userId;
}
