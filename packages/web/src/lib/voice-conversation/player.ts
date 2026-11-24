// Plays the reply audio a voice conversation streams down: raw PCM, signed
// 16-bit little-endian, mono, at the rate Rome names. Chunks play back to back
// in the order they came, and `clear` drops everything not played yet at once.

import { loudness } from "@/lib/voice-input/microphone";

export interface PcmPlayer {
  /** Queues one chunk, at `sampleRate`, after those already queued. */
  play(chunk: ArrayBuffer, sampleRate: number): void;
  /** Stops what plays and drops what waits. */
  clear(): void;
  /** How loud the audio playing right now is, from 0 to 1. */
  level(): number;
  /** Stops and releases the audio output. */
  close(): void;
}

// A first chunk starts this far ahead, so the next one is in before it ends.
const LEAD_S = 0.05;

/**
 * Opens the audio output. Call it from the guardian's own click, as browsers
 * start audio only after a gesture.
 */
export function createPcmPlayer(): PcmPlayer {
  const context = new AudioContext();
  void context.resume().catch(() => {});
  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  analyser.connect(context.destination);
  const samples = new Float32Array(analyser.fftSize);
  const playing = new Set<AudioBufferSourceNode>();
  let until = 0;
  return {
    play(chunk, sampleRate) {
      const pcm = new Int16Array(chunk);
      if (pcm.length === 0 || context.state === "closed") return;
      const buffer = context.createBuffer(1, pcm.length, sampleRate);
      const channel = buffer.getChannelData(0);
      for (let i = 0; i < pcm.length; i++) channel[i] = (pcm[i] ?? 0) / 0x8000;
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(analyser);
      until = Math.max(until, context.currentTime + LEAD_S);
      source.start(until);
      until += buffer.duration;
      playing.add(source);
      source.onended = () => playing.delete(source);
    },
    clear() {
      for (const source of playing) {
        source.onended = null;
        source.stop();
      }
      playing.clear();
      until = 0;
    },
    level() {
      if (playing.size === 0) return 0;
      analyser.getFloatTimeDomainData(samples);
      return loudness(samples);
    },
    close() {
      this.clear();
      void context.close().catch(() => {});
    },
  };
}
