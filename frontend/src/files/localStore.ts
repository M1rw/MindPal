/**
 * Files kept on this device (IndexedDB).
 *
 *  thumbs   pictures for the file cards in this device's chats, by attachment id
 *  library  a guest's library: the file, its reading, its pictures. Guests have
 *           no server storage, so their library lives here, pruned to the
 *           guest limits (count and days).
 *
 * Everything fails soft: with no IndexedDB (private windows, tests) files still
 * work for the chat they are sent in, they are just not kept. Bytes are stored
 * as ArrayBuffers, not Blobs: WebKit refuses Blobs in IndexedDB in private and
 * ephemeral contexts, and every engine stores an ArrayBuffer.
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

/** A Blob as IndexedDB can always hold it. */
interface StoredBytes {
  bytes: ArrayBuffer;
  type: string;
}

async function toStored(blob: Blob): Promise<StoredBytes> {
  return { bytes: await blob.arrayBuffer(), type: blob.type };
}

function fromStored(value: StoredBytes | Blob | undefined): Blob {
  if (!value) return new Blob();
  if (value instanceof Blob) return value; // written before bytes were stored as buffers
  return new Blob([value.bytes], { type: value.type });
}

interface StoredThumb {
  id: string;
  thumb: StoredBytes;
  previews: StoredBytes[];
  savedAt: number;
}

type StoredLibraryRecord = Omit<LocalLibraryRecord, 'original' | 'thumb' | 'previews'> & {
  original: StoredBytes;
  thumb: StoredBytes;
  previews: StoredBytes[];
};

/** The same file attached again: its id points at the copy already kept. */
interface StoredAlias {
  id: string;
  aliasOf: string;
}

type StoredLibraryRow = StoredLibraryRecord | StoredAlias;

function isAlias(row: StoredLibraryRow): row is StoredAlias {
  return 'aliasOf' in row;
}

function readThumb(stored: StoredThumb): ThumbRecord {
  return { id: stored.id, savedAt: stored.savedAt, thumb: fromStored(stored.thumb), previews: stored.previews.map(fromStored) };
}

function readRecord(stored: StoredLibraryRecord): LocalLibraryRecord {
  return { ...stored, original: fromStored(stored.original), thumb: fromStored(stored.thumb), previews: stored.previews.map(fromStored) };
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
  const stored: StoredThumb = {
    id,
    thumb: await toStored(thumb),
    previews: await Promise.all(previews.map(toStored)),
    savedAt: Date.now(),
  };
  await run(THUMBS, 'readwrite', (s) => s.put(stored));
  void pruneThumbs();
}

export async function loadThumbs(id: string): Promise<ThumbRecord | null> {
  const stored = await run<StoredThumb>(THUMBS, 'readonly', (s) => s.get(id) as IDBRequest<StoredThumb>);
  return stored ? readThumb(stored) : null;
}

async function pruneThumbs(): Promise<void> {
  const all = await run<StoredThumb[]>(THUMBS, 'readonly', (s) => s.getAll() as IDBRequest<StoredThumb[]>);
  if (!all || all.length <= MAX_THUMBS) return;
  const oldest = all.sort((a, b) => a.savedAt - b.savedAt).slice(0, all.length - MAX_THUMBS);
  for (const record of oldest) await run(THUMBS, 'readwrite', (s) => s.delete(record.id));
}

export async function clearThumbs(): Promise<void> {
  await run(THUMBS, 'readwrite', (s) => s.clear());
}

// --- a guest's library -------------------------------------------------------------

async function allRows(): Promise<StoredLibraryRow[]> {
  return (await run<StoredLibraryRow[]>(LIBRARY, 'readonly', (s) => s.getAll() as IDBRequest<StoredLibraryRow[]>)) ?? [];
}

export async function listLocalLibrary(maxFiles: number, maxDays: number): Promise<LocalLibraryRecord[]> {
  const all = (await allRows()).filter((row): row is StoredLibraryRecord => !isAlias(row)).map(readRecord);
  const cutoff = Date.now() - maxDays * 86_400_000;
  const sorted = all.sort((a, b) => b.createdAt - a.createdAt);
  const keep = sorted.filter((r) => r.createdAt >= cutoff).slice(0, maxFiles);
  const drop = sorted.filter((r) => !keep.includes(r));
  for (const record of drop) await run(LIBRARY, 'readwrite', (s) => s.delete(record.id));
  return keep;
}

/** Every file in the guest library, newest first. Read-only: never prunes (listLocalLibrary does). */
export async function readLocalLibrary(): Promise<LocalLibraryRecord[]> {
  const all = (await allRows()).filter((row): row is StoredLibraryRecord => !isAlias(row)).map(readRecord);
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export async function getLocalFile(id: string): Promise<LocalLibraryRecord | null> {
  let row = await run<StoredLibraryRow>(LIBRARY, 'readonly', (s) => s.get(id) as IDBRequest<StoredLibraryRow>);
  if (row && isAlias(row)) {
    const target = row.aliasOf;
    row = await run<StoredLibraryRow>(LIBRARY, 'readonly', (s) => s.get(target) as IDBRequest<StoredLibraryRow>);
  }
  return row && !isAlias(row) ? readRecord(row) : null;
}

/**
 * Keep a file, once: the same content attached again becomes an alias of the
 * copy already kept, so the library lists it once and every message still
 * finds its file.
 */
export async function putLocalFile(record: LocalLibraryRecord): Promise<boolean> {
  const existing = (await allRows()).find((row) => !isAlias(row) && row.hash === record.hash && row.id !== record.id);
  if (existing) {
    const alias: StoredAlias = { id: record.id, aliasOf: existing.id };
    return (await run(LIBRARY, 'readwrite', (s) => s.put(alias))) !== null;
  }
  return storeRecord(record);
}

async function storeRecord(record: LocalLibraryRecord): Promise<boolean> {
  const stored: StoredLibraryRecord = {
    ...record,
    original: await toStored(record.original),
    thumb: await toStored(record.thumb),
    previews: await Promise.all(record.previews.map(toStored)),
  };
  return (await run(LIBRARY, 'readwrite', (s) => s.put(stored))) !== null;
}

export async function deleteLocalFile(id: string): Promise<void> {
  await run(LIBRARY, 'readwrite', (s) => s.delete(id));
}

export async function renameLocalFile(id: string, name: string): Promise<void> {
  const record = await getLocalFile(id);
  if (record) await storeRecord({ ...record, name });
}
