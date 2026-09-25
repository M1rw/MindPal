/**
 * The files and library endpoints (backend/http/files.py).
 */
import { fetchJson } from '../services/api/http.ts';
import type { Digest, FileAllowance, LibraryFile, LibraryUsage, PageDigest } from './types.ts';

const READ_TIMEOUT_MS = 90_000;

export interface DigestPageIn {
  n: number;
  text?: string;
  /** base64 JPEG of the rendered page, for the vision pipeline. */
  image?: string;
  mime?: string;
}

export const filesApi = {
  async digestImage(image: Blob, hash: string, name: string): Promise<Digest> {
    const res = await fetchJson<{ digest: Digest }>(
      '/api/files/digest/image',
      {
        method: 'POST',
        body: image,
        headers: {
          'Content-Type': image.type || 'image/jpeg',
          'X-File-Hash': hash,
          // Headers are Latin-1: names in any script travel percent-encoded.
          'X-File-Name': encodeURIComponent(name.slice(0, 200)),
        },
        timeoutMs: READ_TIMEOUT_MS,
      },
      "MindPal couldn't read that image.",
    );
    return res.digest;
  },

  async digestPages(hash: string, name: string, totalPages: number, pages: DigestPageIn[]): Promise<PageDigest[]> {
    const res = await fetchJson<{ pages: PageDigest[] }>(
      '/api/files/digest/pages',
      {
        method: 'POST',
        body: JSON.stringify({ hash, name, total_pages: totalPages, pages }),
        timeoutMs: READ_TIMEOUT_MS,
      },
      "MindPal couldn't read those pages.",
    );
    return res.pages;
  },

  async assemble(name: string, totalPages: number, pages: PageDigest[]): Promise<Digest> {
    const res = await fetchJson<{ digest: Digest }>(
      '/api/files/digest/assemble',
      { method: 'POST', body: JSON.stringify({ name, total_pages: totalPages, pages }), timeoutMs: 30_000 },
      "MindPal couldn't put that PDF together.",
    );
    return res.digest;
  },

  allowance(): Promise<FileAllowance> {
    return fetchJson<FileAllowance>('/api/files/allowance', {}, 'Could not load file limits.');
  },
};

export interface StartUpload {
  file_id: string;
  existing: boolean;
  uploads: Record<string, string>;
}

export const libraryApi = {
  list(q = ''): Promise<{ files: LibraryFile[]; usage: LibraryUsage }> {
    const query = q.trim() ? `?q=${encodeURIComponent(q.trim())}` : '';
    return fetchJson('/api/library' + query, {}, 'Could not load your library.');
  },

  get(id: string): Promise<LibraryFile & { digest: Digest; url: string; preview_urls: string[] }> {
    return fetchJson(`/api/library/${encodeURIComponent(id)}`, {}, 'Could not open that file.');
  },

  start(body: { name: string; mime: string; size: number; hash: string; pages: number; previews: number }): Promise<StartUpload> {
    return fetchJson('/api/library/upload', { method: 'POST', body: JSON.stringify(body) }, 'Could not save to your library.');
  },

  complete(id: string, digest: Digest): Promise<LibraryFile> {
    return fetchJson(
      `/api/library/${encodeURIComponent(id)}/complete`,
      { method: 'POST', body: JSON.stringify({ digest }), timeoutMs: 30_000 },
      'Could not save to your library.',
    );
  },

  rename(id: string, name: string): Promise<LibraryFile> {
    return fetchJson(`/api/library/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ name }) }, 'Could not rename that file.');
  },

  remove(id: string): Promise<{ deleted: boolean }> {
    return fetchJson(`/api/library/${encodeURIComponent(id)}`, { method: 'DELETE' }, 'Could not delete that file.');
  },
};

/** Straight to storage with a signed link: no MindPal credentials go with it. */
export async function uploadToSignedUrl(url: string, blob: Blob, signal?: AbortSignal): Promise<void> {
  const response = await fetch(url, {
    method: 'PUT',
    body: blob,
    headers: { 'Content-Type': blob.type || 'application/octet-stream', 'x-upsert': 'true' },
    signal,
  });
  if (!response.ok) throw new Error('The upload did not finish. Please try again.');
}
