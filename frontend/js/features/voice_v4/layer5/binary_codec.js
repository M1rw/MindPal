import { isValidBase64 } from "../layer2/index.js";

export function base64ToBytes(value, atobImplementation = globalThis.atob) {
  if (!isValidBase64(value) || typeof atobImplementation !== "function") {
    throw new TypeError("audio data is not valid base64");
  }
  const binary = atobImplementation(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function bytesToBase64(bytes, btoaImplementation = globalThis.btoa) {
  if (!(bytes instanceof Uint8Array) || typeof btoaImplementation !== "function") {
    throw new TypeError("audio bytes cannot be encoded");
  }
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoaImplementation(binary);
}
