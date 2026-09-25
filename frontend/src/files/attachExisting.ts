/**
 * Put a file that was already read (in the library, or on this device) back in
 * the composer, without reading it again.
 */
import { useComposerFilesStore } from '../store/composerFiles.ts';
import { libraryApi } from './api.ts';
import { getLocalFile } from './localStore.ts';
import { rememberOriginal, rememberPictures } from './session.ts';
import type { PendingAttachment } from './types.ts';

export async function attachExisting(ref: { localId?: string; fileId?: string }): Promise<void> {
  let item: PendingAttachment | null = null;
  const record = ref.localId ? await getLocalFile(ref.localId) : null;
  if (record) {
    const thumbUrl = URL.createObjectURL(record.thumb);
    const previewUrls = record.previews.map((blob) => URL.createObjectURL(blob));
    rememberPictures(record.id, { thumbUrl, previewUrls });
    rememberOriginal(record.id, record.original);
    item = {
      id: record.id, kind: record.kind, name: record.name, mime: record.mime, size: record.size, pages: record.pages,
      status: 'ready', progress: { done: 1, total: 1 }, hash: record.hash, digest: record.digest, thumbUrl, previewUrls,
    };
  } else if (ref.fileId) {
    const full = await libraryApi.get(ref.fileId);
    const id = `att_${ref.fileId.slice(2)}_${Date.now().toString(36)}`;
    const previewUrls = full.preview_urls.filter(Boolean);
    rememberPictures(id, { thumbUrl: full.thumb_url, previewUrls });
    item = {
      id, kind: full.kind, name: full.name, mime: full.mime, size: full.size, pages: full.pages, fileId: full.id,
      status: 'ready', progress: { done: 1, total: 1 }, hash: '', digest: full.digest, thumbUrl: full.thumb_url, previewUrls,
    };
  }
  if (!item) throw new Error('That file is no longer available.');
  useComposerFilesStore.getState().addReady(item);
}
