// Microphone capture as raw PCM for the dictation socket: signed 16-bit
// little-endian, mono, at the AudioContext's rate. Chrome resamples the
// microphone to the rate the context asks for.

import { VOICE_INPUT_SAMPLE_RATE } from "@rome/api-types/voice-input";

// Runs on the audio thread. Batches about 100 ms of samples per message.
const WORKLET_SOURCE = `
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = Math.round(sampleRate / 10);
    this.buffer = new Int16Array(this.size);
    this.filled = 0;
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i++) {
      const s = Math.max(-1, Math.min(1, channel[i]));
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
  /** Releases the microphone. Safe to call more than once. */
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
    context = new AudioContext({ sampleRate: VOICE_INPUT_SAMPLE_RATE });
    const moduleUrl = URL.createObjectURL(
      new Blob([WORKLET_SOURCE], { type: "application/javascript" }),
    );
    try {
      await context.audioWorklet.addModule(moduleUrl);
    } finally {
      URL.revokeObjectURL(moduleUrl);
    }
    const source = context.createMediaStreamSource(stream);
    const capture = new AudioWorkletNode(context, "rome-pcm-capture");
    capture.port.onmessage = (event: MessageEvent<ArrayBuffer>) => onAudio(event.data);
    source.connect(capture);
    let closed = false;
    const opened = context;
    return {
      sampleRate: opened.sampleRate,
      close() {
        if (closed) return;
        closed = true;
        capture.port.onmessage = null;
        source.disconnect();
        capture.disconnect();
        for (const track of stream.getTracks()) track.stop();
        void opened.close();
      },
    };
  } catch (error) {
    for (const track of stream.getTracks()) track.stop();
    void context?.close();
    throw error;
  }
}
