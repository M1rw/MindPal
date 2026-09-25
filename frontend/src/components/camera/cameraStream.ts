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

/**
 * A stream shaped like the viewfinder: portrait on a portrait phone. Asking a
 * phone held upright for 1920x1080 made it deliver a landscape frame that the
 * tall viewfinder then had to crop hard, which zoomed the front camera far in.
 */
export function openStream(facing: Facing): Promise<MediaStream> {
  const portrait = typeof window === 'undefined' || window.innerHeight >= window.innerWidth;
  return navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: { ideal: facing },
      width: { ideal: portrait ? 1440 : 1920 },
      height: { ideal: portrait ? 1920 : 1440 },
      aspectRatio: { ideal: portrait ? 3 / 4 : 4 / 3 },
    },
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

/** What the live camera can do beyond a picture: a torch, optical zoom. */
export interface CameraAbilities {
  torch: boolean;
  zoom: { min: number; max: number } | null;
}

type TrackCapabilities = MediaTrackCapabilities & { torch?: boolean; zoom?: { min: number; max: number } };

export function abilitiesOf(stream: MediaStream | null): CameraAbilities {
  const track = stream?.getVideoTracks()[0];
  const caps = (track?.getCapabilities?.() ?? {}) as TrackCapabilities;
  return {
    torch: Boolean(caps.torch),
    zoom: caps.zoom && caps.zoom.max > caps.zoom.min ? { min: caps.zoom.min, max: caps.zoom.max } : null,
  };
}

/** Constraints that only some cameras accept; a refusal is not an error worth showing. */
export async function applyAdvanced(stream: MediaStream | null, constraint: Record<string, unknown>): Promise<boolean> {
  const track = stream?.getVideoTracks()[0];
  if (!track) return false;
  try {
    await track.applyConstraints({ advanced: [constraint as MediaTrackConstraintSet] });
    return true;
  } catch {
    return false;
  }
}

/** A sentence for the person, from a getUserMedia failure. */
export function cameraErrorMessage(error: unknown): string {
  const name = (error as { name?: string })?.name ?? '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Camera access is off. Allow it in your browser settings, or use your camera app instead.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No camera was found on this device.';
  if (name === 'NotReadableError') return 'The camera is being used by another app.';
  return "The camera couldn't start.";
}
