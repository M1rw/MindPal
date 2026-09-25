/**
 * Files kept on this device (IndexedDB).
 *
 *  thumbs   pictures for the file cards in this device's chats, by attachment id
 *  library  a guest's library: the file, its reading, its pictures. Guests have
 *           no server storage, so their library lives here, pruned to the
 *           guest limits (count and days).
 *
 * Everything fails soft: with no IndexedDB (private windows, tests) files still
 * work for the chat they are sent in, they are just not kept.
 */
import type { Digest, FileKind } from './types.ts';

const DB_NAME = 'mindpal-files';
const DB_VERSION = 1;
const THUMBS = 'thumbs';
const LIBRARY = 'library';
const MAX_THUMBS = 300;

export interface ThumbRecord {
  id: string;
  thumb: Blob;
  previews: Blob[];
  savedAt: number;
}

export interface LocalLibraryRecord {
  id: string;
  name: string;
  mime: string;
  kind: FileKind;
  size: number;
  pages: number;
  hash: string;
  digest: Digest;
  original: Blob;
  thumb: Blob;
  previews: Blob[];
  createdAt: number;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(THUMBS)) db.createObjectStore(THUMBS, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(LIBRARY)) db.createObjectStore(LIBRARY, { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function run<T>(store: string, mode: IDBTransactionMode, act: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return openDb().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) return resolve(null);
        try {
          const request = act(db.transaction(store, mode).objectStore(store));
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      }),
  );
}

// --- thumbnails -----------------------------------------------------------------

export async function saveThumbs(id: string, thumb: Blob, previews: Blob[] = []): Promise<void> {
  await run(THUMBS, 'readwrite', (s) => s.put({ id, thumb, previews, savedAt: Date.now() } satisfies ThumbRecord));
  void pruneThumbs();
}

export function loadThumbs(id: string): Promise<ThumbRecord | null> {
  return run<ThumbRecord>(THUMBS, 'readonly', (s) => s.get(id) as IDBRequest<ThumbRecord>);
}

async function pruneThumbs(): Promise<void> {
  const all = await run<ThumbRecord[]>(THUMBS, 'readonly', (s) => s.getAll() as IDBRequest<ThumbRecord[]>);
  if (!all || all.length <= MAX_THUMBS) return;
  const oldest = all.sort((a, b) => a.savedAt - b.savedAt).slice(0, all.length - MAX_THUMBS);
  for (const record of oldest) await run(THUMBS, 'readwrite', (s) => s.delete(record.id));
}

export async function clearThumbs(): Promise<void> {
  await run(THUMBS, 'readwrite', (s) => s.clear());
}

// --- a guest's library -------------------------------------------------------------

export async function listLocalLibrary(maxFiles: number, maxDays: number): Promise<LocalLibraryRecord[]> {
  const all = (await run<LocalLibraryRecord[]>(LIBRARY, 'readonly', (s) => s.getAll() as IDBRequest<LocalLibraryRecord[]>)) ?? [];
  const cutoff = Date.now() - maxDays * 86_400_000;
  const sorted = all.sort((a, b) => b.createdAt - a.createdAt);
  const keep = sorted.filter((r) => r.createdAt >= cutoff).slice(0, maxFiles);
  const drop = sorted.filter((r) => !keep.includes(r));
  for (const record of drop) await run(LIBRARY, 'readwrite', (s) => s.delete(record.id));
  return keep;
}

export function getLocalFile(id: string): Promise<LocalLibraryRecord | null> {
  return run<LocalLibraryRecord>(LIBRARY, 'readonly', (s) => s.get(id) as IDBRequest<LocalLibraryRecord>);
}

export async function putLocalFile(record: LocalLibraryRecord): Promise<boolean> {
  return (await run(LIBRARY, 'readwrite', (s) => s.put(record))) !== null;
}

export async function deleteLocalFile(id: string): Promise<void> {
  await run(LIBRARY, 'readwrite', (s) => s.delete(id));
}

export async function renameLocalFile(id: string, name: string): Promise<void> {
  const record = await getLocalFile(id);
  if (record) await putLocalFile({ ...record, name });
}
