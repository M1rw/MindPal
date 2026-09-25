/**
 * The files a chat request carries: this turn's, plus the ones shared earlier
 * in the conversation, so "and on page 3?" still has the PDF in view.
 */
import type { ChatMessage } from '../types/index.ts';
import { getLocalFile, readLocalLibrary } from './localStore.ts';
import { pickFromLibrary, pointsAtFiles } from './libraryPick.ts';
import { sessionDigest } from './session.ts';
import type { Digest, MessageAttachment, PendingAttachment } from './types.ts';

/** Mirrors max_files_in_context in backend/configs/json/api_limits.json. */
export const MAX_FILES_IN_CONTEXT = 8;
/** How far back an earlier file stays in view. */
const LOOKBACK_MESSAGES = 24;

export interface AttachmentPayload {
  file_id?: string;
  digest?: Digest;
  name: string;
  image?: string;
  mime?: string;
  earlier?: boolean;
  /** Found in their on-device library because the message pointed at it; not attached. */
  library?: boolean;
}

async function digestFor(attachment: MessageAttachment): Promise<Digest | undefined> {
  return sessionDigest(attachment.id) ?? (await getLocalFile(attachment.id))?.digest;
}

async function refFor(attachment: MessageAttachment, signedIn: boolean, earlier: boolean): Promise<AttachmentPayload | null> {
  if (signedIn && attachment.fileId) return { file_id: attachment.fileId, name: attachment.name, earlier };
  const digest = await digestFor(attachment);
  return digest ? { digest, name: attachment.name, earlier } : null;
}

export function toMessageAttachment(item: PendingAttachment): MessageAttachment {
  const out: MessageAttachment = { id: item.id, kind: item.kind, name: item.name };
  if (item.mime) out.mime = item.mime;
  if (item.pages) out.pages = item.pages;
  if (item.size) out.size = item.size;
  if (item.fileId) out.fileId = item.fileId;
  return out;
}

/**
 * `fresh`: files just added (their picture goes along); `resent`: the files of
 * a message being regenerated or edited (read again from their digests);
 * `history`: the conversation before this turn. `message`: what they wrote;
 * a guest who points at one of their files ("my lease") gets it found in
 * their on-device library when nothing was attached.
 */
export async function turnAttachments(options: {
  fresh?: PendingAttachment[];
  resent?: MessageAttachment[];
  history: ChatMessage[];
  signedIn: boolean;
  message?: string;
}): Promise<AttachmentPayload[]> {
  const { fresh = [], resent = [], history, signedIn, message = '' } = options;
  const out: AttachmentPayload[] = [];
  const seen = new Set<string>();
  for (const item of fresh) {
    seen.add(item.id);
    const ref: AttachmentPayload =
      signedIn && item.fileId ? { file_id: item.fileId, name: item.name } : { digest: item.digest, name: item.name };
    if (item.turnImage) {
      ref.image = item.turnImage.data;
      ref.mime = item.turnImage.mime;
    }
    if (ref.file_id || ref.digest) out.push(ref);
  }
  for (const attachment of resent) {
    if (seen.has(attachment.id)) continue;
    seen.add(attachment.id);
    const ref = await refFor(attachment, signedIn, false);
    if (ref) out.push(ref);
  }
  const recent = history.slice(-LOOKBACK_MESSAGES).reverse();
  for (const message of recent) {
    for (const attachment of message.attachments ?? []) {
      if (out.length >= MAX_FILES_IN_CONTEXT) return out;
      if (seen.has(attachment.id)) continue;
      seen.add(attachment.id);
      const ref = await refFor(attachment, signedIn, true);
      if (ref) out.push(ref);
    }
  }
  if (!out.length && !signedIn && pointsAtFiles(message)) {
    // Nothing attached or in view, and they mean one of their files: find it.
    const picked = await pickLocal(message);
    if (picked) return [picked];
  }
  return out.slice(0, MAX_FILES_IN_CONTEXT);
}

async function pickLocal(message: string): Promise<AttachmentPayload | null> {
  try {
    const file = pickFromLibrary(message, await readLocalLibrary());
    return file ? { digest: file.digest, name: file.name, library: true } : null;
  } catch {
    return null; // no library on this device (private mode, blocked storage): send as is
  }
}
