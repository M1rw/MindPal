export type VoiceV3FeatureName =
  | "VOICE_V3_ENABLED"
  | "VOICE_V3_VERBAL_CUES_ENABLED"
  | "VOICE_V3_PROSODY_CONTEXT_ENABLED"
  | "VOICE_V3_MEMORY_ENABLED"
  | "VOICE_V3_CLARIFICATION_ENABLED";

export type VoiceV3FeatureFlags = Readonly<Record<VoiceV3FeatureName, boolean>>;

export type VoiceV3FlagContext = {
  readonly environment?: string;
  readonly userKey?: string | null;
  readonly sessionKey?: string | null;
  readonly overrides?: Partial<Record<VoiceV3FeatureName, boolean>>;
  readonly userOverrides?: Partial<Record<VoiceV3FeatureName, boolean>>;
  readonly sessionOverrides?: Partial<Record<VoiceV3FeatureName, boolean>>;
};

export const DEFAULT_VOICE_V3_FEATURE_FLAGS: VoiceV3FeatureFlags = {
  VOICE_V3_ENABLED: false,
  VOICE_V3_VERBAL_CUES_ENABLED: true,
  VOICE_V3_PROSODY_CONTEXT_ENABLED: true,
  VOICE_V3_MEMORY_ENABLED: true,
  VOICE_V3_CLARIFICATION_ENABLED: true,
};

export function evaluateVoiceV3Flags(
  context: VoiceV3FlagContext = {},
  environmentValues: Record<string, unknown> = readRuntimeEnvironment(),
): VoiceV3FeatureFlags {
  const evaluated = {} as Record<VoiceV3FeatureName, boolean>;
  for (const name of Object.keys(DEFAULT_VOICE_V3_FEATURE_FLAGS) as VoiceV3FeatureName[]) {
    const envValue = readBoolean(environmentValues[name]);
    const base = envValue ?? DEFAULT_VOICE_V3_FEATURE_FLAGS[name];
    evaluated[name] = context.overrides?.[name] ?? base;
    if (context.userKey && context.userOverrides?.[name] !== undefined) evaluated[name] = context.userOverrides[name] as boolean;
    if (context.sessionKey && context.sessionOverrides?.[name] !== undefined) evaluated[name] = context.sessionOverrides[name] as boolean;
  }
  if (!evaluated.VOICE_V3_ENABLED) {
    evaluated.VOICE_V3_VERBAL_CUES_ENABLED = false;
    evaluated.VOICE_V3_PROSODY_CONTEXT_ENABLED = false;
  }
  return evaluated;
}

export function featureFlagsForEnvironment(environment: string, overrides: Partial<Record<VoiceV3FeatureName, boolean>> = {}): VoiceV3FeatureFlags {
  return evaluateVoiceV3Flags({ environment, overrides });
}

function readRuntimeEnvironment(): Record<string, unknown> {
  const runtime = (globalThis as { __MINDPAL_VOICE_V3_FLAGS__?: unknown }).__MINDPAL_VOICE_V3_FLAGS__;
  const runtimeValues = typeof runtime === "object" && runtime !== null ? runtime as Record<string, unknown> : {};
  const viteValues = typeof import.meta.env === "object" ? import.meta.env as Record<string, unknown> : {};
  const merged: Record<string, unknown> = { ...viteValues, ...runtimeValues };
  for (const name of Object.keys(DEFAULT_VOICE_V3_FEATURE_FLAGS)) {
    if (merged[name] === undefined && merged[`VITE_${name}`] !== undefined) merged[name] = merged[`VITE_${name}`];
  }
  return merged;
}

function readBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "on") return true;
  if (normalized === "false" || normalized === "0" || normalized === "off") return false;
  return null;
}
