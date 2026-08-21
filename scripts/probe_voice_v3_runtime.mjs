globalThis.window = {};
try {
  const runtime = await import("../frontend/voice-v3/assets/runtime.js");
  if (typeof globalThis.window.__MINDPAL_VOICE_V3_RUNTIME__?.createVoiceV3Controller !== "function") {
    throw new Error("global createVoiceV3Controller missing");
  }
  console.log("runtime module evaluation passed");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
