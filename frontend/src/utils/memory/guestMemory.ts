/**
 * Per-device guest memory. Atoms stay in this browser until sign-in.
 * Device ids are never sent to the API — there is no signed guest token.
 */

import { STORAGE_KEYS } from '../../constants/storage.ts';
import type { MemoryAtom, MemoryReceipt } from '../../types/index.ts';

export const SHARED_ANON_GRAPH_KEY = 'usr_anon_default';
const MAX_ATOMS = 16;
const DEVICE_ID_BYTES = 16;
const GUEST_ID_PATTERN = /^gst_[0-9a-f]{32}$/i;
const BLOCKED_GRAPH_KEYS = new Set([
  '',
  'anonymous',
  'guest',
  SHARED_ANON_GRAPH_KEY,
  'usr_anonymous',
  'usr_guest',
]);

export type MemoryStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

export type GuestMemoryGraph = {
  deviceId: string;
  atoms: MemoryAtom[];
};

export function canPersistUserMemory(userIdHash: string): boolean {
  const key = (userIdHash || '').trim();
  if (!key || BLOCKED_GRAPH_KEYS.has(key.toLowerCase())) return false;
  if (key.toLowerCase().startsWith('usr_anon')) return false;
  return key.startsWith('usr_');
}

export function isGuestDeviceId(value: string | null | undefined): boolean {
  return GUEST_ID_PATTERN.test((value || '').trim());
}

export function canWriteGuestGraph(deviceId: string): boolean {
  const key = (deviceId || '').trim();
  if (!isGuestDeviceId(key)) return false;
  if (BLOCKED_GRAPH_KEYS.has(key.toLowerCase())) return false;
  if (key.toLowerCase().startsWith('usr_anon')) return false;
  return !canPersistUserMemory(key);
}

export function guestMemoryStorageKey(deviceId: string): string {
  return `${STORAGE_KEYS.GUEST_MEMORY}:${deviceId}`;
}

export function createGuestDeviceId(randomBytes: (size: number) => Uint8Array = defaultRandomBytes): string {
  const bytes = randomBytes(DEVICE_ID_BYTES);
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `gst_${hex}`;
}

export function getOrCreateGuestDeviceId(storage: MemoryStorage = browserStorage()): string {
  try {
    const existing = storage.getItem(STORAGE_KEYS.GUEST_DEVICE_ID);
    if (existing && canWriteGuestGraph(existing)) return existing;
    const created = createGuestDeviceId();
    storage.setItem(STORAGE_KEYS.GUEST_DEVICE_ID, created);
    return created;
  } catch {
    return '';
  }
}

export function loadGuestGraph(storage: MemoryStorage = browserStorage(), deviceId?: string): GuestMemoryGraph {
  try {
    const id = deviceId || getOrCreateGuestDeviceId(storage);
    if (!canWriteGuestGraph(id)) {
      return { deviceId: '', atoms: [] };
    }
    const raw = storage.getItem(guestMemoryStorageKey(id));
    if (!raw) return { deviceId: id, atoms: [] };
    const parsed = JSON.parse(raw) as Partial<GuestMemoryGraph>;
    if (parsed.deviceId && parsed.deviceId !== id) return { deviceId: id, atoms: [] };
    return { deviceId: id, atoms: sanitizeAtoms(parsed.atoms) };
  } catch {
    return { deviceId: '', atoms: [] };
  }
}

export function saveGuestGraph(graph: GuestMemoryGraph, storage: MemoryStorage = browserStorage()): boolean {
  if (!canWriteGuestGraph(graph.deviceId) || graph.deviceId === SHARED_ANON_GRAPH_KEY) {
    return false;
  }
  try {
    const payload: GuestMemoryGraph = {
      deviceId: graph.deviceId,
      atoms: graph.atoms.slice(0, MAX_ATOMS),
    };
    storage.setItem(guestMemoryStorageKey(graph.deviceId), JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

export function clearGuestGraph(storage: MemoryStorage = browserStorage(), deviceId?: string): void {
  try {
    const id = deviceId || storage.getItem(STORAGE_KEYS.GUEST_DEVICE_ID) || '';
    if (!id || !canWriteGuestGraph(id)) return;
    storage.removeItem(guestMemoryStorageKey(id));
  } catch {
    // Ignore quota / private-mode failures.
  }
}

export function mergeAtomLists(existing: MemoryAtom[], incoming: MemoryAtom[]): MemoryAtom[] {
  const merged = existing.map(cloneAtom);
  const byId = new Map(merged.map((atom, index) => [atom.id, index]));
  const seenValues = new Set(merged.map((atom) => normalizeAtomValue(atom.value)));

  for (const atom of incoming) {
    const value = atom.value.trim();
    if (!value || !atom.id.trim()) continue;
    const normalized = normalizeAtomValue(value);
    const index = byId.get(atom.id);
    if (index !== undefined) {
      const current = merged[index];
      if (atom.confidence >= current.confidence) {
        seenValues.delete(normalizeAtomValue(current.value));
        const updated = cloneAtom({ ...atom, value });
        merged[index] = updated;
        seenValues.add(normalized);
      }
      continue;
    }
    if (seenValues.has(normalized)) continue;
    const created = cloneAtom({ ...atom, value });
    byId.set(created.id, merged.length);
    seenValues.add(normalized);
    merged.push(created);
  }

  return merged.slice(0, MAX_ATOMS);
}

export function rememberReceipt(
  receipt: MemoryReceipt,
  storage: MemoryStorage = browserStorage(),
): MemoryReceipt | null {
  const deviceId = getOrCreateGuestDeviceId(storage);
  if (!canWriteGuestGraph(deviceId)) return null;
  const incoming = atomsFromReceipt(receipt);
  if (incoming.length === 0) return null;
  const current = loadGuestGraph(storage, deviceId);
  const next = { deviceId, atoms: mergeAtomLists(current.atoms, incoming) };
  if (!saveGuestGraph(next, storage)) return null;
  return receipt;
}

export function captureMemoryReceipt(
  receipt: MemoryReceipt,
  signedIn: boolean,
  storage: MemoryStorage = browserStorage(),
): MemoryReceipt | null {
  if (signedIn) return receipt;
  return rememberReceipt(receipt, storage);
}

export function deleteGuestAtom(
  atomId: string,
  storage: MemoryStorage = browserStorage(),
): boolean {
  const current = loadGuestGraph(storage);
  if (!current.deviceId) return false;
  const nextAtoms = current.atoms.filter((atom) => atom.id !== atomId);
  return saveGuestGraph({ ...current, atoms: nextAtoms }, storage);
}

const MAX_ATOM_VALUE_CHARS = 240;

export function updateGuestAtom(
  atomId: string,
  value: string,
  storage: MemoryStorage = browserStorage(),
): MemoryAtom | null {
  const text = clipGuestAtomValue(value);
  const key = atomId.trim();
  if (!text || !key) return null;
  const current = loadGuestGraph(storage);
  if (!current.deviceId) return null;
  const index = current.atoms.findIndex((atom) => atom.id === key);
  if (index < 0) return null;
  const updated: MemoryAtom = {
    ...cloneAtom(current.atoms[index]),
    value: text,
    updated_at: new Date().toISOString(),
  };
  const nextAtoms = current.atoms.slice();
  nextAtoms[index] = updated;
  if (!saveGuestGraph({ ...current, atoms: nextAtoms }, storage)) return null;
  return updated;
}

function clipGuestAtomValue(value: string): string {
  const text = value.trim().replace(/\s+/g, ' ');
  if (text.length <= MAX_ATOM_VALUE_CHARS) return text;
  const clipped = text.slice(0, MAX_ATOM_VALUE_CHARS).replace(/\s+\S*$/, '').trim();
  return clipped || text.slice(0, MAX_ATOM_VALUE_CHARS);
}

export function atomsFromReceipt(receipt: MemoryReceipt): MemoryAtom[] {
  const now = new Date().toISOString();
  return receipt.saved
    .filter((item) => item.id.trim() && item.text.trim())
    .map((item) => ({
      id: item.id.trim(),
      type: item.type.trim() || 'facts',
      value: item.text.trim(),
      confidence: 0.8,
      created_at: now,
    }));
}

function sanitizeAtoms(raw: unknown): MemoryAtom[] {
  if (!Array.isArray(raw)) return [];
  const atoms: MemoryAtom[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    const value = typeof record.value === 'string' ? record.value.trim() : '';
    if (!id || !value || seen.has(id)) continue;
    seen.add(id);
    const confidence = typeof record.confidence === 'number' && Number.isFinite(record.confidence) ? record.confidence : 0.8;
    atoms.push({
      id,
      type: typeof record.type === 'string' && record.type.trim() ? record.type.trim() : 'facts',
      value,
      confidence,
      created_at: typeof record.created_at === 'string' ? record.created_at : '',
      updated_at: typeof record.updated_at === 'string' ? record.updated_at : undefined,
    });
  }
  return atoms.slice(0, MAX_ATOMS);
}

function cloneAtom(atom: MemoryAtom): MemoryAtom {
  return {
    id: atom.id,
    type: atom.type,
    value: atom.value,
    normalized_value: atom.normalized_value,
    confidence: atom.confidence,
    created_at: atom.created_at,
    updated_at: atom.updated_at,
  };
}

function normalizeAtomValue(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function defaultRandomBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return bytes;
}

function browserStorage(): MemoryStorage {
  return localStorage;
}
