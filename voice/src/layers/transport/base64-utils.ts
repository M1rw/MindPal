const BASE64_CHUNK_BYTES = 24_576; // divisible by 3; safe argument count for browsers

/**
 * Encode bytes in bounded chunks. The chunk size is divisible by three so
 * concatenating per-chunk Base64 blocks is equivalent to encoding the whole
 * byte sequence, while avoiding an unbounded main-thread string conversion.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";
  let encoded = "";
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_BYTES) {
    const end = Math.min(offset + BASE64_CHUNK_BYTES, bytes.length);
    const chunk = bytes.subarray(offset, end);
    const binary = String.fromCharCode(...chunk);
    encoded += globalThis.btoa(binary);
  }
  return encoded;
}

export function int16ToBase64(pcm: Int16Array | ArrayBuffer): string {
  const bytes = pcm instanceof ArrayBuffer ? new Uint8Array(pcm) : new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  return bytesToBase64(bytes);
}

export function base64ToBytes(value: string): Uint8Array {
  if (value.length === 0) return new Uint8Array(0);
  const binary = globalThis.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function base64ToInt16(value: string): Int16Array {
  const bytes = base64ToBytes(value);
  if (bytes.byteLength % Int16Array.BYTES_PER_ELEMENT !== 0) {
    throw new RangeError("Base64 payload is not aligned to 16-bit PCM samples");
  }
  return new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / Int16Array.BYTES_PER_ELEMENT);
}
