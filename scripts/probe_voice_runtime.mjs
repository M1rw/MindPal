globalThis.window = {};
try {
  await import("../frontend/voice/assets/runtime.js");
  const win = globalThis.window;
  const factory = win.__MINDPAL_VOICE_RUNTIME__?.createVoiceController || win.__MINDPAL_VOICE_V3_RUNTIME__?.createVoiceV3Controller;
  if (typeof factory !== "function") {
    throw new Error("global createVoiceController missing");
  }
  console.log("runtime module evaluation passed");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
