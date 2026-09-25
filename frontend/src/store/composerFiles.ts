/**
 * Files in the composer: reading as soon as they are added, ready by the time
 * the message is. Each file is also kept in the library in the background: an
 * account's in cloud storage, a guest's on this device.
 */
import { create } from 'zustand';
import { filesApi, libraryApi, uploadToSignedUrl } from '../files/api.ts';
import { putLocalFile, saveThumbs } from '../files/localStore.ts';
import { checkLimits, PDF_PREVIEWS, readFile, type ReadOutcome } from '../files/reader.ts';
import { rememberDigest, rememberOriginal, rememberPictures } from '../files/session.ts';
import { kindOf, type FileAllowance, type PendingAttachment } from '../files/types.ts';
import { useChatStore } from './chat.ts';
import { useSessionStore } from './session.ts';

export const MAX_COMPOSER_FILES = 4;

interface ComposerFilesState {
  items: PendingAttachment[];
  allowance: FileAllowance | null;
  /** A short reason shown on the composer when a file is refused. */
  notice: string | null;
  add: (files: File[]) => void;
  /** A file already read (from the library): attach without reading again. */
  addReady: (item: PendingAttachment) => void;
  remove: (id: string) => void;
  /** Hand the ready files to a message and empty the composer. */
  take: () => PendingAttachment[];
  clear: () => void;
  refreshAllowance: () => Promise<FileAllowance | null>;
  setNotice: (notice: string | null) => void;
}

function newId(): string {
  const random = globalThis.crypto?.randomUUID?.().replace(/-/g, '').slice(0, 16) ?? Math.random().toString(36).slice(2, 18);
  return `att_${random}`;
}

export const useComposerFilesStore = create<ComposerFilesState>((set, get) => {
  const patch = (id: string, update: Partial<PendingAttachment>) =>
    set((state) => ({ items: state.items.map((item) => (item.id === id ? { ...item, ...update } : item)) }));
  const alive = (id: string) => get().items.some((item) => item.id === id);

  const read = async (id: string, file: File) => {
    let limits = get().allowance;
    if (!limits) limits = await get().refreshAllowance();
    let outcome: ReadOutcome;
    try {
      outcome = await readFile(file, limits, (done, total) => {
        if (alive(id)) patch(id, { progress: { done, total } });
      });
    } catch (error) {
      if (alive(id)) patch(id, { status: 'error', error: (error as Error).message || "Couldn't read that file." });
      return;
    }
    if (!alive(id)) return;
    const thumbUrl = URL.createObjectURL(outcome.thumb);
    const previewUrls = outcome.previews.map((blob) => URL.createObjectURL(blob));
    const current = get().items.find((item) => item.id === id);
    if (current?.thumbUrl && current.thumbUrl !== thumbUrl) URL.revokeObjectURL(current.thumbUrl);
    patch(id, {
      status: 'ready',
      digest: outcome.digest,
      hash: outcome.hash,
      pages: outcome.pages,
      turnImage: outcome.turnImage,
      thumbUrl,
      previewUrls,
      progress: { done: outcome.pages, total: outcome.pages },
    });
    rememberDigest(id, outcome.digest);
    rememberPictures(id, { thumbUrl, previewUrls });
    rememberOriginal(id, file);
    void saveThumbs(id, outcome.thumb, outcome.previews);
    void keepInLibrary(id, file, outcome, patch);
    void get().refreshAllowance();
  };

  return {
    items: [],
    allowance: null,
    notice: null,
    setNotice: (notice) => set({ notice }),

    add: (files) => {
      const room = MAX_COMPOSER_FILES - get().items.length;
      if (room <= 0) {
        set({ notice: `Up to ${MAX_COMPOSER_FILES} files per message.` });
        return;
      }
      if (files.length > room) set({ notice: `Up to ${MAX_COMPOSER_FILES} files per message.` });
      for (const file of files.slice(0, room)) {
        const kind = kindOf(file.type, file.name);
        const refused = checkLimits(file, get().allowance);
        if (!kind || refused) {
          set({ notice: refused ?? 'Only images and PDFs can be attached.' });
          continue;
        }
        const id = newId();
        const item: PendingAttachment = {
          id,
          kind,
          name: file.name || (kind === 'image' ? 'Photo.jpg' : 'Document.pdf'),
          mime: file.type || (kind === 'pdf' ? 'application/pdf' : 'image/jpeg'),
          size: file.size,
          status: 'reading',
          progress: { done: 0, total: 1 },
          hash: '',
          // A picture shows at once from the original; a PDF once its first page is drawn.
          thumbUrl: kind === 'image' ? URL.createObjectURL(file) : undefined,
          previewUrls: [],
        };
        set((state) => ({ items: [...state.items, item] }));
        void read(id, file);
      }
    },

    addReady: (item) => {
      if (get().items.length >= MAX_COMPOSER_FILES) {
        set({ notice: `Up to ${MAX_COMPOSER_FILES} files per message.` });
        return;
      }
      if (get().items.some((existing) => existing.id === item.id)) return;
      if (item.digest) rememberDigest(item.id, item.digest);
      set((state) => ({ items: [...state.items, item] }));
    },

    remove: (id) => {
      const item = get().items.find((entry) => entry.id === id);
      // A removed file's pictures are not in any message: free them.
      if (item?.thumbUrl) URL.revokeObjectURL(item.thumbUrl);
      item?.previewUrls.forEach((url) => URL.revokeObjectURL(url));
      set((state) => ({ items: state.items.filter((entry) => entry.id !== id), notice: null }));
    },

    take: () => {
      // Sending waits for files still being read (the composer blocks it), so
      // what is left is ready or failed; failed ones are dropped with the send.
      const ready = get().items.filter((item) => item.status === 'ready');
      get()
        .items.filter((item) => item.status === 'error')
        .forEach((item) => get().remove(item.id));
      set({ items: [], notice: null });
      return ready;
    },

    clear: () => {
      get().items.forEach((item) => get().remove(item.id));
      set({ items: [], notice: null });
    },

    refreshAllowance: async () => {
      try {
        const allowance = await filesApi.allowance();
        set({ allowance });
        return allowance;
      } catch {
        return get().allowance;
      }
    },
  };
});

/** Background save to the library; the file works in chat whether or not this succeeds. */
async function keepInLibrary(
  id: string,
  file: File,
  outcome: ReadOutcome,
  patch: (id: string, update: Partial<PendingAttachment>) => void,
): Promise<void> {
  const kind = outcome.digest.kind;
  const mime = file.type || (kind === 'pdf' ? 'application/pdf' : 'image/jpeg');
  if (!useSessionStore.getState().isAuthenticated) {
    await putLocalFile({
      id,
      name: file.name,
      mime,
      kind,
      size: file.size,
      pages: outcome.pages,
      hash: outcome.hash,
      digest: outcome.digest,
      original: file,
      thumb: outcome.thumb,
      previews: outcome.previews,
      createdAt: Date.now(),
    });
    return;
  }
  try {
    const previews = outcome.previews.slice(0, PDF_PREVIEWS);
    const started = await libraryApi.start({
      name: file.name,
      mime,
      size: file.size,
      hash: outcome.hash,
      pages: outcome.pages,
      previews: previews.length,
    });
    if (!started.existing) {
      const uploads: Array<Promise<void>> = [uploadToSignedUrl(started.uploads.original, file)];
      if (started.uploads.thumb) uploads.push(uploadToSignedUrl(started.uploads.thumb, outcome.thumb));
      previews.forEach((blob, index) => {
        const url = started.uploads[`p${index + 1}`];
        if (url) uploads.push(uploadToSignedUrl(url, blob));
      });
      await Promise.all(uploads);
      await libraryApi.complete(started.file_id, outcome.digest);
    }
    patch(id, { fileId: started.file_id });
    // Messages already sent with this file pick the id up for synced chats.
    useChatStore.getState().setAttachmentFileId(id, started.file_id);
  } catch {
    // Library full or storage down: the file still goes with this message.
  }
}
