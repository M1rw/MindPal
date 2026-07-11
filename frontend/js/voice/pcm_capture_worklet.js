class MindPalPcmProcessor extends AudioWorkletProcessor {
  constructor(options = {}) {
    super();
    const requestedFrameSize = Number(options.processorOptions?.frameSize);
    this.frameSize = Number.isInteger(requestedFrameSize) && requestedFrameSize > 0
      ? requestedFrameSize
      : 2_048;
    this.buffer = new Float32Array(this.frameSize);
    this.offset = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;

    for (let index = 0; index < channel.length; index += 1) {
      this.buffer[this.offset] = channel[index];
      this.offset += 1;

      if (this.offset >= this.buffer.length) {
        this.port.postMessage(this.buffer, [this.buffer.buffer]);
        this.buffer = new Float32Array(this.frameSize);
        this.offset = 0;
      }
    }

    return true;
  }
}

registerProcessor("mindpal-pcm-processor", MindPalPcmProcessor);
