// Microphone capture as raw PCM for the dictation socket: signed 16-bit
// little-endian, mono, at 16 kHz. The AudioContext runs at the device's own
// rate, because Firefox refuses a microphone source on a context at another
// rate, and the worklet brings the audio down to 16 kHz.

import { VOICE_INPUT_SAMPLE_RATE } from "@rome/api-types/voice-input";
import { chosenMicrophone, findMicrophone, listMicrophones } from "./microphone-choice";

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

const AUDIO = { channelCount: 1, echoCancellation: true, noiseSuppression: true };

/** Opens `id` when it is connected, otherwise the system default. */
function open(id?: string): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: id ? { ...AUDIO, deviceId: { ideal: id } } : AUDIO,
  });
}

function recordsFrom(stream: MediaStream, id: string): boolean {
  return stream.getAudioTracks()[0]?.getSettings().deviceId === id;
}

/**
 * Opens the chosen microphone, or the system default when none is chosen or
 * the chosen one is not connected. Never changes the choice.
 */
export async function openMicrophoneStream(): Promise<MediaStream> {
  const chosen = chosenMicrophone();
  const stream = await open(chosen?.id);
  if (!chosen?.label || recordsFrom(stream, chosen.id)) return stream;
  // The id can be new on each page load. With the microphone now allowed the
  // browser names its devices, so look for the chosen one by name.
  const match = findMicrophone(chosen, (await listMicrophones().catch(() => null)) ?? []);
  if (!match || recordsFrom(stream, match.id)) return stream;
  // Released first: on iOS Safari a second capture can end the first.
  for (const track of stream.getTracks()) track.stop();
  return open(match.id).catch(() => open());
}

export interface Microphone {
  readonly sampleRate: number;
  /**
   * Stops listening, hands the last captured audio to `onAudio`, then
   * releases the microphone. Resolves once the last chunk is out.
   */
  finish(): Promise<void>;
  /** Releases the microphone at once, dropping audio not yet handed over. Safe to call more than once. */
  close(): void;
  /** How loud the microphone is right now, from 0 for a quiet room to 1 for close, loud speech. */
  level(): number;
}

// -55 dBFS, a quiet room, reads as 0, and -10 dBFS, close loud speech, as 1.
const QUIET_DB = -55;
const LOUD_DB = -10;

/** The loudness of `samples` on the 0 to 1 scale `Microphone.level` reports. */
export function loudness(samples: Float32Array): number {
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  const rms = Math.sqrt(sum / (samples.length || 1));
  const db = 20 * Math.log10(rms || 1e-8);
  return Math.max(0, Math.min(1, (db - QUIET_DB) / (LOUD_DB - QUIET_DB)));
}

/**
 * Opens the microphone and calls `onAudio` with each chunk until `close()`.
 * Calls `onAsk` when the browser asks the guardian for the microphone, which
 * it does while the permission is unset. Rejects with the browser's
 * `DOMException` when the microphone is refused (`NotAllowedError`) or
 * missing (`NotFoundError`).
 */
export async function openMicrophone(
  onAudio: (chunk: ArrayBuffer) => void,
  onAsk?: () => void,
): Promise<Microphone> {
  let answered = false;
  // Chrome's permission prompt opens when the permission is unset.
  navigator.permissions
    ?.query({ name: "microphone" as PermissionName })
    .then((status) => {
      if (status.state === "prompt" && !answered) onAsk?.();
    })
    .catch(() => {
      // A browser that cannot tell just shows no reason.
    });
  let stream: MediaStream;
  try {
    stream = await openMicrophoneStream();
  } finally {
    answered = true;
  }
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
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    let closed = false;
    const opened = context;
    const close = () => {
      if (closed) return;
      closed = true;
      capture.port.onmessage = null;
      source.disconnect();
      capture.disconnect();
      analyser.disconnect();
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
      level() {
        if (closed) return 0;
        analyser.getFloatTimeDomainData(samples);
        return loudness(samples);
      },
    };
  } catch (error) {
    for (const track of stream.getTracks()) track.stop();
    void context?.close();
    throw error;
  }
}
