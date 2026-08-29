class MindPalCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    const channels = input.map((channel) => new Float32Array(channel));
    this.port.postMessage({ channels }, channels.map((channel) => channel.buffer));
    return true;
  }
}

registerProcessor("mindpal-v4-capture", MindPalCaptureProcessor);
