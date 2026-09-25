/**
 * Files in MindPal (v5.0.5): what a file becomes once read, and what a chat
 * message keeps about it. Mirrors backend/domain/files/contracts.py.
 */

export type FileKind = 'image' | 'pdf';
export type PageKind = 'text' | 'visual' | 'mixed' | 'empty';

export interface PageDigest {
  n: number;
  kind: PageKind;
  text: string;
  description: string;
}

/** A file read into text and descriptions, page by page. */
export interface Digest {
  version: number;
  kind: FileKind;
  content: PageKind;
  name: string;
  title: string;
  summary: string;
  language: string;
  total_pages: number;
  pages: PageDigest[];
}

/**
 * What a chat message keeps about a file: identity and shape only. Pictures
 * come from this device's cache, or signed library links; never stored here.
 */
export interface MessageAttachment {
  /** Local id: the key for this device's thumbnail cache. */
  id: string;
  kind: FileKind;
  name: string;
  mime?: string;
  pages?: number;
  size?: number;
  /** The account library file, once uploaded. */
  fileId?: string;
}

export type AttachmentStatus = 'reading' | 'ready' | 'error';

/** A file in the composer, being read or ready to send. */
export interface PendingAttachment extends MessageAttachment {
  status: AttachmentStatus;
  /** Pages read so far, of the total (images are one page). */
  progress: { done: number; total: number };
  error?: string;
  hash: string;
  digest?: Digest;
  /** Object URLs for this session. */
  thumbUrl?: string;
  previewUrls: string[];
  /** A picture's downscaled copy, sent with its first turn so the reply can look at it. */
  turnImage?: { data: string; mime: string };
}

/** Today's allowance and the caller's limits (GET /api/files/allowance). */
export interface FileAllowance {
  files_used: number;
  files_limit: number;
  vision_pages_used: number;
  vision_pages_limit: number;
  max_image_bytes: number;
  max_pdf_bytes: number;
  max_pdf_pages: number;
  library_files: number;
  library_bytes: number;
  library_days: number;
  max_attachments: number;
  signed_in: boolean;
}

export interface LibraryFile {
  id: string;
  name: string;
  mime: string;
  kind: FileKind;
  size: number;
  pages: number;
  content: PageKind | '';
  title: string;
  summary: string;
  previews: number;
  created_at: number;
  thumb_url?: string;
  /** Guest files: on this device only. */
  local?: boolean;
}

export interface LibraryUsage {
  files: number;
  bytes: number;
  files_limit: number;
  bytes_limit: number;
}

export const ACCEPTED_TYPES = 'image/jpeg,image/png,image/webp,image/gif,image/heic,image/heif,application/pdf';

export function kindOf(mime: string, name = ''): FileKind | null {
  const type = (mime || '').toLowerCase();
  if (type === 'application/pdf' || name.toLowerCase().endsWith('.pdf')) return 'pdf';
  if (type.startsWith('image/')) return 'image';
  return null;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}
