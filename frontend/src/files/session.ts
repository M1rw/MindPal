/**
 * What this tab remembers about files it has seen: readings and pictures by
 * attachment id, so a follow-up question can bring an earlier file back into
 * view, and a sent file's card shows its picture without a round trip.
 */
import type { Digest } from './types.ts';

export interface SessionPictures {
  thumbUrl?: string;
  previewUrls: string[];
}

const digests = new Map<string, Digest>();
const pictures = new Map<string, SessionPictures>();
const originals = new Map<string, Blob>();

/** The file itself, for the viewer, while this tab is open. */
export function rememberOriginal(id: string, blob: Blob): void {
  originals.set(id, blob);
}

export function sessionOriginal(id: string): Blob | undefined {
  return originals.get(id);
}

export function rememberDigest(id: string, digest: Digest): void {
  digests.set(id, digest);
}

export function sessionDigest(id: string): Digest | undefined {
  return digests.get(id);
}

export function rememberPictures(id: string, value: SessionPictures): void {
  pictures.set(id, value);
}

export function sessionPictures(id: string): SessionPictures | undefined {
  return pictures.get(id);
}

/** Sign-out: nothing of this account's files stays in memory. */
export function forgetSessionFiles(): void {
  for (const value of pictures.values()) {
    if (value.thumbUrl) URL.revokeObjectURL(value.thumbUrl);
    value.previewUrls.forEach((url) => URL.revokeObjectURL(url));
  }
  pictures.clear();
  digests.clear();
  originals.clear();
}
