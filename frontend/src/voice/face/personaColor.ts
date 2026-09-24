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

// One colour family per voice, matched to its personality, so the orb tells
// the voices apart at a glance. Stops: edge, middle, highlight.
const BY_VOICE: Record<string, PersonaPalette> = {
  // Warm and grounded: amber, rose, violet (the house look).
  sulafat: {
    id: 'sulafat',
    stops: [
      { r: 168, g: 85, b: 247 },
      { r: 244, g: 114, b: 182 },
      { r: 251, g: 146, b: 60 },
    ],
  },
  // Thoughtful: sky and indigo.
  aoede: {
    id: 'aoede',
    stops: [
      { r: 56, g: 189, b: 248 },
      { r: 99, g: 102, b: 241 },
      { r: 125, g: 211, b: 252 },
    ],
  },
  // Deep and calm: midnight navy into deep teal.
  charon: {
    id: 'charon',
    stops: [
      { r: 30, g: 58, b: 138 },
      { r: 13, g: 148, b: 136 },
      { r: 49, g: 46, b: 129 },
    ],
  },
  // Clear and direct: cobalt and electric violet.
  kore: {
    id: 'kore',
    stops: [
      { r: 37, g: 99, b: 235 },
      { r: 124, g: 58, b: 237 },
      { r: 96, g: 165, b: 250 },
    ],
  },
  // Playful: lime, sunshine and mint.
  puck: {
    id: 'puck',
    stops: [
      { r: 132, g: 204, b: 22 },
      { r: 250, g: 204, b: 21 },
      { r: 52, g: 211, b: 153 },
    ],
  },
  // Energetic: crimson, flame and hot magenta.
  fenrir: {
    id: 'fenrir',
    stops: [
      { r: 220, g: 38, b: 38 },
      { r: 249, g: 115, b: 22 },
      { r: 219, g: 39, b: 119 },
    ],
  },
  // Friendly: teal, mint and sky.
  achird: {
    id: 'achird',
    stops: [
      { r: 13, g: 148, b: 136 },
      { r: 110, g: 231, b: 183 },
      { r: 56, g: 189, b: 248 },
    ],
  },
  // Easy-going: dusk slate, periwinkle and sage.
  umbriel: {
    id: 'umbriel',
    stops: [
      { r: 71, g: 85, b: 105 },
      { r: 129, g: 140, b: 248 },
      { r: 134, g: 239, b: 172 },
    ],
  },
  // Gentle: lavender, blush and lilac.
  vindemiatrix: {
    id: 'vindemiatrix',
    stops: [
      { r: 167, g: 139, b: 250 },
      { r: 249, g: 168, b: 212 },
      { r: 221, g: 214, b: 254 },
    ],
  },
  // Lively: hot pink, violet and cyan.
  sadachbia: {
    id: 'sadachbia',
    stops: [
      { r: 236, g: 72, b: 153 },
      { r: 168, g: 85, b: 247 },
      { r: 34, g: 211, b: 238 },
    ],
  },
  // Upbeat: sunshine, tangerine and coral.
  laomedeia: {
    id: 'laomedeia',
    stops: [
      { r: 250, g: 204, b: 21 },
      { r: 251, g: 146, b: 60 },
      { r: 251, g: 113, b: 133 },
    ],
  },
  // Bright and clear: aqua, ice and azure.
  zephyr: {
    id: 'zephyr',
    stops: [
      { r: 6, g: 182, b: 212 },
      { r: 165, g: 243, b: 252 },
      { r: 59, g: 130, b: 246 },
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
