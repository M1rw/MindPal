/**
 * The camera, asked for inside the tap that wants it.
 *
 * iOS Safari only grants getUserMedia during a user gesture, so the request
 * starts in the click handler and the sheet picks the pending stream up once it
 * mounts. Returns false when this browser cannot use a camera in-page; the
 * caller then falls back to the phone's own camera (a capture file input).
 */
import { useLibraryStore } from '../../store/library.ts';

export type Facing = 'environment' | 'user';

let pending: Promise<MediaStream> | null = null;

export function cameraSupported(): boolean {
  return typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia);
}

export function openStream(facing: Facing): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    audio: false,
  });
}

export function requestCamera(): boolean {
  if (!cameraSupported()) return false;
  pending = openStream('environment');
  // Handled by the sheet; never an unhandled rejection meanwhile.
  pending.catch(() => {});
  useLibraryStore.getState().setCameraOpen(true);
  return true;
}

/** The stream asked for by the last tap, once. */
export function takePendingStream(): Promise<MediaStream> | null {
  const stream = pending;
  pending = null;
  return stream;
}

export function stopStream(stream: MediaStream | null | undefined): void {
  stream?.getTracks().forEach((track) => track.stop());
}

/** A sentence for the person, from a getUserMedia failure. */
export function cameraErrorMessage(error: unknown): string {
  const name = (error as { name?: string })?.name ?? '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Camera access is off. Allow it in your browser settings, or use your camera app instead.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return "No camera was found on this device.";
  if (name === 'NotReadableError') return 'The camera is being used by another app.';
  return "The camera couldn't start.";
}
