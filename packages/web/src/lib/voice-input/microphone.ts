// Microphone capture as raw PCM for the dictation socket: signed 16-bit
// little-endian, mono, at 16 kHz. The AudioContext runs at the device's own
// rate, because Firefox refuses a microphone source on a context at another
// rate, and the worklet brings the audio down to 16 kHz.

import { VOICE_INPUT_SAMPLE_RATE } from "@rome/api-types/voice-input";

// Runs on the audio thread. Each output sample is the mean of the input
// samples it covers, which also filters out most content above the new
// Nyquist rate. Posts about 100 ms of output per message.
const WORKLET_SOURCE = `
class PcmCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.target = options.processorOptions.targetRate;
    this.step = sampleRate / this.target;
    this.size = Math.round(this.target / 10);
    this.buffer = new Int16Array(this.size);
    this.filled = 0;
    this.sum = 0;
    this.count = 0;
    this.position = 0;
    // "flush" posts the samples short of a full buffer, then "flushed".
    this.port.onmessage = (event) => {
      if (event.data !== "flush") return;
      if (this.filled > 0) {
        const rest = this.buffer.slice(0, this.filled);
        this.port.postMessage(rest.buffer, [rest.buffer]);
        this.filled = 0;
      }
      this.port.postMessage("flushed");
    };
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i++) {
      this.sum += channel[i];
      this.count += 1;
      this.position += 1;
      if (this.position < this.step) continue;
      this.position -= this.step;
      const s = Math.max(-1, Math.min(1, this.sum / this.count));
      this.sum = 0;
      this.count = 0;
      this.buffer[this.filled++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.filled === this.size) {
        this.port.postMessage(this.buffer.buffer, [this.buffer.buffer]);
        this.buffer = new Int16Array(this.size);
        this.filled = 0;
      }
    }
    return true;
  }
}
registerProcessor("rome-pcm-capture", PcmCapture);
`;

export interface Microphone {
  readonly sampleRate: number;
  /**
   * Stops listening, hands the last captured audio to `onAudio`, then
   * releases the microphone. Resolves once the last chunk is out.
   */
  finish(): Promise<void>;
  /** Releases the microphone at once, dropping audio not yet handed over. Safe to call more than once. */
  close(): void;
}

/**
 * Opens the microphone and calls `onAudio` with each chunk until `close()`.
 * Rejects with the browser's `DOMException` when the microphone is refused
 * (`NotAllowedError`) or missing (`NotFoundError`).
 */
export async function openMicrophone(onAudio: (chunk: ArrayBuffer) => void): Promise<Microphone> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });
  let context: AudioContext | null = null;
  try {
    context = new AudioContext();
    const moduleUrl = URL.createObjectURL(
      new Blob([WORKLET_SOURCE], { type: "application/javascript" }),
    );
    try {
      await context.audioWorklet.addModule(moduleUrl);
    } finally {
      URL.revokeObjectURL(moduleUrl);
    }
    const source = context.createMediaStreamSource(stream);
    // A device slower than 16 kHz is sent at its own rate.
    const targetRate = Math.min(VOICE_INPUT_SAMPLE_RATE, context.sampleRate);
    const capture = new AudioWorkletNode(context, "rome-pcm-capture", {
      processorOptions: { targetRate },
    });
    let flushed: (() => void) | null = null;
    capture.port.onmessage = (event: MessageEvent<ArrayBuffer | string>) => {
      if (typeof event.data === "string") flushed?.();
      else onAudio(event.data);
    };
    source.connect(capture);
    let closed = false;
    const opened = context;
    const close = () => {
      if (closed) return;
      closed = true;
      capture.port.onmessage = null;
      source.disconnect();
      capture.disconnect();
      for (const track of stream.getTracks()) track.stop();
      void opened.close();
    };
    return {
      sampleRate: targetRate,
      async finish() {
        if (closed) return;
        for (const track of stream.getTracks()) track.stop();
        source.disconnect();
        await new Promise<void>((resolve) => {
          flushed = resolve;
          // The audio thread answers within one render quantum; this only
          // guards a context that has already stopped.
          setTimeout(resolve, 500);
          capture.port.postMessage("flush");
        });
        close();
      },
      close,
    };
  } catch (error) {
    for (const track of stream.getTracks()) track.stop();
    void context?.close();
    throw error;
  }
}
