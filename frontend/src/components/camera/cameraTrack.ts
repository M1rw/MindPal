/** What a camera track can do beyond a picture (torch, zoom); kept free of the app's stores so it can be tested on its own. */
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

/**
 * Back to 1×, the camera's own widest view (the zoom chips count from it). A
 * camera can keep the zoom it last had, so a new stream may open zoomed in while
 * the sheet says 1×; set it explicitly before the first frame is shown.
 */
export async function resetZoom(stream: MediaStream | null, abilities: CameraAbilities = abilitiesOf(stream)): Promise<boolean> {
  if (!abilities.zoom) return false;
  return applyAdvanced(stream, { zoom: abilities.zoom.min });
}
