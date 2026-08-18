import { createCaptureAdapter } from "./capture_adapter.js";

function createAnalyser(audioContext, source, fftSize = 256) {
  if (!audioContext?.createAnalyser || !source) return null;
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = fftSize;
  analyser.smoothingTimeConstant = 0.82;
  source.connect(analyser);
  return analyser;
}

export async function createBrowserAudioAdapter({
  onAudio = () => {},
  onQuality = () => {},
  onVolume = () => {},
  workletUrl = new URL("../pcm_capture_worklet.js", import.meta.url),
  frameSize = 2_048,
} = {}) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("Microphone access is unavailable in this browser.");
  const AudioContextImpl = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AudioContextImpl) throw new Error("Web Audio is unavailable in this browser.");

  const mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  const audioContext = new AudioContextImpl({ sampleRate: 16_000 });
  if (audioContext.state === "suspended") await audioContext.resume();
  const source = audioContext.createMediaStreamSource(mediaStream);
  const micAnalyser = createAnalyser(audioContext, source);
  let workletNode = null;
  let scriptNode = null;
  let sink = null;

  const capture = createCaptureAdapter({ onAudio, onQuality, sampleRate: 16_000 });
  const emitVolume = (frame) => {
    const values = frame instanceof Float32Array ? frame : Float32Array.from(frame || []);
    if (!values.length) return;
    const rms = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length);
    onVolume(Math.min(1, rms * 7));
  };

  const handleFrame = (frame) => {
    emitVolume(frame);
    capture.processFrame(frame);
  };

  try {
    if (audioContext.audioWorklet?.addModule && typeof AudioWorkletNode === "function") {
      await audioContext.audioWorklet.addModule(workletUrl);
      workletNode = new AudioWorkletNode(audioContext, "mindpal-pcm-processor", {
        processorOptions: { frameSize },
      });
      workletNode.port.onmessage = (event) => handleFrame(new Float32Array(event.data));
      source.connect(workletNode);
      sink = audioContext.createGain();
      sink.gain.value = 0;
      workletNode.connect(sink);
      sink.connect(audioContext.destination);
    } else {
      scriptNode = audioContext.createScriptProcessor(2_048, 1, 1);
      scriptNode.onaudioprocess = (event) => handleFrame(event.inputBuffer.getChannelData(0));
      source.connect(scriptNode);
      sink = audioContext.createGain();
      sink.gain.value = 0;
      scriptNode.connect(sink);
      sink.connect(audioContext.destination);
    }
  } catch (error) {
    mediaStream.getTracks().forEach((track) => track.stop());
    await audioContext.close().catch(() => {});
    throw error;
  }

  return Object.freeze({
    start: () => capture.start(),
    stop: () => capture.stop(),
    setMuted: (muted) => {
      capture.setMuted(muted);
      mediaStream.getAudioTracks().forEach((track) => { track.enabled = !muted; });
    },
    processFrame: capture.processFrame,
    isActive: capture.isActive,
    isMuted: capture.isMuted,
    getFrameCount: capture.getFrameCount,
    getAudioContext: () => audioContext,
    getMicAnalyser: () => micAnalyser,
    getMediaStream: () => mediaStream,
    async dispose() {
      capture.stop();
      try { workletNode?.disconnect(); } catch { /* already disconnected */ }
      try { scriptNode?.disconnect(); } catch { /* already disconnected */ }
      try { source.disconnect(); } catch { /* already disconnected */ }
      try { sink?.disconnect(); } catch { /* already disconnected */ }
      mediaStream.getTracks().forEach((track) => track.stop());
      if (audioContext.state !== "closed") await audioContext.close().catch(() => {});
    },
  });
}
