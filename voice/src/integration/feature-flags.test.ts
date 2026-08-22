import { describe, expect, it } from "vitest";
import { evaluateVoiceV3Flags } from "./feature-flags";

describe("Voice V3 feature flags", () => {
  it("keeps V3 and dependent capabilities off by default", () => {
    const flags = evaluateVoiceV3Flags({}, {});
    expect(flags.VOICE_V3_ENABLED).toBe(false);
    expect(flags.VOICE_V3_VERBAL_CUES_ENABLED).toBe(false);
    expect(flags.VOICE_V3_PROSODY_CONTEXT_ENABLED).toBe(false);
  });

  it("supports environment values and session-over-user precedence", () => {
    const flags = evaluateVoiceV3Flags(
      {
        environment: "staging",
        userKey: "user-1",
        sessionKey: "session-1",
        userOverrides: { VOICE_V3_ENABLED: true, VOICE_V3_MEMORY_ENABLED: false },
        sessionOverrides: { VOICE_V3_ENABLED: false },
      },
      { VOICE_V3_ENABLED: "true", VOICE_V3_VERBAL_CUES_ENABLED: "true" },
    );
    expect(flags.VOICE_V3_ENABLED).toBe(false);
    expect(flags.VOICE_V3_MEMORY_ENABLED).toBe(false);
    expect(flags.VOICE_V3_VERBAL_CUES_ENABLED).toBe(false);
  });

  it("allows an enabled session to turn on controlled capabilities", () => {
    const flags = evaluateVoiceV3Flags(
      { sessionKey: "session-allow", sessionOverrides: { VOICE_V3_ENABLED: true } },
      { VOICE_V3_ENABLED: false },
    );
    expect(flags.VOICE_V3_ENABLED).toBe(true);
    expect(flags.VOICE_V3_VERBAL_CUES_ENABLED).toBe(true);
    expect(flags.VOICE_V3_PROSODY_CONTEXT_ENABLED).toBe(true);
  });
});
