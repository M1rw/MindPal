export interface PersonaPalette {
  id: string;
  stops: Array<{ r: number; g: number; b: number }>;
}

const DEFAULT: PersonaPalette = {
  id: 'default',
  stops: [
    { r: 65, g: 64, b: 253 },
    { r: 101, g: 114, b: 242 },
    { r: 163, g: 156, b: 249 },
  ],
};

const BY_VOICE: Record<string, PersonaPalette> = {
  sulafat: {
    id: 'sulafat',
    stops: [
      { r: 168, g: 85, b: 247 },
      { r: 244, g: 114, b: 182 },
      { r: 251, g: 146, b: 60 },
    ],
  },
  kore: {
    id: 'kore',
    stops: [
      { r: 66, g: 133, b: 244 },
      { r: 154, g: 109, b: 255 },
      { r: 65, g: 64, b: 253 },
    ],
  },
  aoede: {
    id: 'aoede',
    stops: [
      { r: 56, g: 189, b: 248 },
      { r: 99, g: 102, b: 241 },
      { r: 125, g: 211, b: 252 },
    ],
  },
  puck: {
    id: 'puck',
    stops: [
      { r: 251, g: 146, b: 60 },
      { r: 244, g: 114, b: 182 },
      { r: 250, g: 204, b: 21 },
    ],
  },
  charon: {
    id: 'charon',
    stops: [
      { r: 79, g: 70, b: 229 },
      { r: 14, g: 165, b: 233 },
      { r: 100, g: 116, b: 139 },
    ],
  },
  fenrir: {
    id: 'fenrir',
    stops: [
      { r: 244, g: 63, b: 94 },
      { r: 251, g: 146, b: 60 },
      { r: 168, g: 85, b: 247 },
    ],
  },
  orus: {
    id: 'orus',
    stops: [
      { r: 30, g: 41, b: 59 },
      { r: 67, g: 56, b: 202 },
      { r: 99, g: 102, b: 241 },
    ],
  },
  achernar: {
    id: 'achernar',
    stops: [
      { r: 196, g: 181, b: 253 },
      { r: 167, g: 139, b: 250 },
      { r: 232, g: 121, b: 249 },
    ],
  },
  vindemiatrix: {
    id: 'vindemiatrix',
    stops: [
      { r: 45, g: 212, b: 191 },
      { r: 125, g: 211, b: 252 },
      { r: 167, g: 139, b: 250 },
    ],
  },
};

export function personaPalette(voiceId: string): PersonaPalette {
  const key = voiceId.trim().toLowerCase();
  return BY_VOICE[key] || DEFAULT;
}

/** Coherent temperature shift from MindPal's own state — not a user-emotion meter. */
export function personaPaletteForAffect(
  base: PersonaPalette,
  affect: { alertness: number; warmth: number; strain: number } | null | undefined,
): PersonaPalette {
  if (!affect) return base;
  const warm = (affect.warmth - 0.64) * 22;
  const perk = (affect.alertness - 0.55) * 14;
  const firm = Math.min(0.42, Math.max(0, affect.strain)) * 16;
  return {
    id: base.id,
    stops: base.stops.map((stop) => ({
      r: clampChannel(stop.r + warm + perk - firm * 0.35),
      g: clampChannel(stop.g + perk * 0.45 - firm * 0.2 + warm * 0.15),
      b: clampChannel(stop.b - warm * 0.55 + firm * 0.45 - perk * 0.1),
    })),
  };
}

function clampChannel(value: number): number {
  return Math.min(255, Math.max(0, value));
}

export function rgb(stop: { r: number; g: number; b: number }, alpha = 1): string {
  if (alpha >= 1) return `rgb(${Math.round(stop.r)}, ${Math.round(stop.g)}, ${Math.round(stop.b)})`;
  return `rgba(${Math.round(stop.r)}, ${Math.round(stop.g)}, ${Math.round(stop.b)}, ${alpha})`;
}

export function lerpStop(
  from: { r: number; g: number; b: number },
  to: { r: number; g: number; b: number },
  t: number,
): { r: number; g: number; b: number } {
  const k = Math.min(1, Math.max(0, t));
  return {
    r: from.r + (to.r - from.r) * k,
    g: from.g + (to.g - from.g) * k,
    b: from.b + (to.b - from.b) * k,
  };
}
