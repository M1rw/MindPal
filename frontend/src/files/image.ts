/**
 * Pictures, prepared on the device: decoded once, downscaled, hashed.
 *
 * A phone photo is 3-8 MB; the model reads a 1568 px JPEG just as well, so
 * about 300 KB goes up instead. Hashing the original lets the server answer a
 * file it has already read from cache, for free.
 */

/** Long edge for the copy the model reads. */
export const READ_EDGE = 1568;
/** Long edge for the copy sent along with a chat turn. */
export const TURN_EDGE = 1024;
/** Long edge for thumbnails and page previews. */
export const THUMB_EDGE = 320;

export async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

type Drawable = ImageBitmap | HTMLImageElement;

async function decode(blob: Blob): Promise<Drawable> {
  if (typeof createImageBitmap === 'function') {
    try {
      // EXIF orientation applied, so phone photos are not sideways.
      return await createImageBitmap(blob, { imageOrientation: 'from-image' });
    } catch {
      /* fall through: some formats only decode through <img> (HEIC on Safari) */
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } catch {
    throw new Error("This photo format can't be opened here. Try a JPEG or PNG.");
  } finally {
    URL.revokeObjectURL(url);
  }
}

function sizeOf(image: Drawable): { width: number; height: number } {
  return 'naturalWidth' in image
    ? { width: image.naturalWidth, height: image.naturalHeight }
    : { width: image.width, height: image.height };
}

export async function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not encode the image.'))), type, quality);
  });
}

export function drawScaled(image: Drawable | HTMLCanvasElement, maxEdge: number): HTMLCanvasElement {
  const { width, height } =
    image instanceof HTMLCanvasElement ? { width: image.width, height: image.height } : sizeOf(image);
  const scale = Math.min(1, maxEdge / Math.max(width, height, 1));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not prepare the image.');
  // JPEG has no transparency: a white page, not a black one.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas;
}

export interface PreparedImage {
  /** For the model (READ_EDGE). */
  read: Blob;
  /** For the chat turn (TURN_EDGE). */
  turn: Blob;
  thumb: Blob;
  width: number;
  height: number;
}

export async function prepareImage(file: Blob): Promise<PreparedImage> {
  const image = await decode(file);
  try {
    const { width, height } = sizeOf(image);
    const read = await canvasToBlob(drawScaled(image, READ_EDGE), 'image/jpeg', 0.85);
    const turn = await canvasToBlob(drawScaled(image, TURN_EDGE), 'image/jpeg', 0.8);
    const thumb = await canvasToBlob(drawScaled(image, THUMB_EDGE), 'image/jpeg', 0.8);
    return { read, turn, thumb, width, height };
  } finally {
    if ('close' in image) image.close();
  }
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
