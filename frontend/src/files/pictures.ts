/**
 * Where a sent file's pictures and original come from, fastest first:
 * this tab, this device (IndexedDB), then the account library (signed links).
 */
import { useEffect, useState } from 'react';
import { useSessionStore } from '../store/session.ts';
import { libraryApi } from './api.ts';
import { getLocalFile, loadThumbs } from './localStore.ts';
import { rememberPictures, sessionOriginal, sessionPictures, type SessionPictures } from './session.ts';
import type { MessageAttachment } from './types.ts';

const inflight = new Map<string, Promise<SessionPictures | null>>();

async function resolvePictures(attachment: MessageAttachment): Promise<SessionPictures | null> {
  const known = sessionPictures(attachment.id);
  if (known) return known;
  const local = await loadThumbs(attachment.id);
  if (local) {
    const value = {
      thumbUrl: URL.createObjectURL(local.thumb),
      previewUrls: local.previews.map((blob) => URL.createObjectURL(blob)),
    };
    rememberPictures(attachment.id, value);
    return value;
  }
  if (attachment.fileId && useSessionStore.getState().isAuthenticated) {
    try {
      const file = await libraryApi.get(attachment.fileId);
      const value = { thumbUrl: file.thumb_url || undefined, previewUrls: (file.preview_urls ?? []).filter(Boolean) };
      rememberPictures(attachment.id, value);
      return value;
    } catch {
      return null;
    }
  }
  return null;
}

/** A sent file's thumbnail and page previews (undefined while loading, null when none). */
export function useAttachmentPictures(attachment: MessageAttachment): SessionPictures | null | undefined {
  const [value, setValue] = useState<SessionPictures | null | undefined>(() => sessionPictures(attachment.id));
  useEffect(() => {
    let cancelled = false;
    if (sessionPictures(attachment.id)) {
      setValue(sessionPictures(attachment.id));
      return;
    }
    let pending = inflight.get(attachment.id);
    if (!pending) {
      pending = resolvePictures(attachment).finally(() => inflight.delete(attachment.id));
      inflight.set(attachment.id, pending);
    }
    void pending.then((result) => {
      if (!cancelled) setValue(result);
    });
    return () => {
      cancelled = true;
    };
  }, [attachment.id, attachment.fileId]);
  return value;
}

/** The original file, for the viewer: this device's copy, or the library's. */
export async function loadOriginal(attachment: MessageAttachment): Promise<Blob | null> {
  const held = sessionOriginal(attachment.id);
  if (held) return held;
  const local = await getLocalFile(attachment.id);
  if (local) return local.original;
  if (attachment.fileId && useSessionStore.getState().isAuthenticated) {
    const file = await libraryApi.get(attachment.fileId);
    if (!file.url) return null;
    const response = await fetch(file.url);
    return response.ok ? response.blob() : null;
  }
  return null;
}
