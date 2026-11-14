// How the environment decides that a request carried audio. Shared by the
// browser's proxy and the server capture so both sides judge alike.
//
// - Visible content: a body or a WebSocket that starts with an audio file's
//   signature, or has an audio content type, carried audio.
// - A WebSocket the environment can read: at least AUDIO_MIN_BYTES of binary
//   frames from the client counts as audio, since the dashboard has no other
//   reason to stream binary data upward.
// - Encrypted traffic, where nothing inside is visible: a sustained upload,
//   at least SUSTAINED_BYTES in each of SUSTAINED_SECONDS different seconds
//   within SUSTAINED_WINDOW seconds of each other, on one connection, counts
//   as audio. A burst, such as a model request, does not, nor do small
//   uploads spread over minutes, such as a browser's update checks.

export const AUDIO_MIN_BYTES = 4096;
export const SUSTAINED_BYTES = 4096;
export const SUSTAINED_SECONDS = 3;
export const SUSTAINED_WINDOW = 10;

const SIGNATURES = [
  [
    "RIFF/WAVE",
    (b) =>
      b.length >= 12 &&
      b.toString("latin1", 0, 4) === "RIFF" &&
      b.toString("latin1", 8, 12) === "WAVE",
  ],
  ["Ogg", (b) => b.toString("latin1", 0, 4) === "OggS"],
  ["WebM/Matroska", (b) => b.length >= 4 && b.readUInt32BE(0) === 0x1a45dfa3],
  ["FLAC", (b) => b.toString("latin1", 0, 4) === "fLaC"],
  ["MP3 (ID3)", (b) => b.toString("latin1", 0, 3) === "ID3"],
  [
    "MP4/M4A",
    (b) =>
      b.length >= 12 &&
      b.toString("latin1", 4, 8) === "ftyp" &&
      /M4A|M4B|mp4a|isom|dash/.test(b.toString("latin1", 8, 12)),
  ],
  ["AAC (ADTS)", (b) => b.length >= 2 && b[0] === 0xff && (b[1] & 0xf6) === 0xf0],
];

// Names the audio format a buffer starts with, or null.
export function signatureAt(buf) {
  for (const [name, test] of SIGNATURES) if (test(buf)) return name;
  return null;
}

// Looks for audio in a request body's first bytes: a signature at the start,
// an audio part in a multipart body, or base64 audio inside JSON.
export function sniffAudio(buf, contentType) {
  if (contentType && /^audio\//i.test(contentType)) return `content type ${contentType}`;
  if (!buf?.length) return null;
  const sig = signatureAt(buf);
  if (sig) return `body starts with ${sig}`;
  const text = buf.toString("latin1");
  const part = /content-type:\s*(audio\/[\w.+-]+)/i.exec(text);
  if (part) return `multipart part ${part[1]}`;
  const b64 = base64AudioIn(text);
  if (b64) return `base64 ${b64} in the body`;
  return null;
}

// Base64 of each signature's first bytes, as it appears inside JSON.
const BASE64_SIGNATURES = [
  ["RIFF/WAVE", "UklGR"],
  ["Ogg", "T2dnU"],
  ["WebM/Matroska", "GkXfo"],
  ["FLAC", "ZkxhQ"],
  ["MP3 (ID3)", "SUQz"],
];
export function base64AudioIn(text) {
  for (const [name, prefix] of BASE64_SIGNATURES) {
    if (new RegExp(`["':,\\s]${prefix}[A-Za-z0-9+/]{200,}`).test(text)) return name;
  }
  return null;
}

export function sustainedUpload(upBySecond) {
  const busy = Object.entries(upBySecond ?? {})
    .filter(([, n]) => n >= SUSTAINED_BYTES)
    .map(([s]) => Number(s))
    .sort((a, b) => a - b);
  // The most busy seconds that fit in one window.
  let most = 0;
  for (let i = 0, j = 0; j < busy.length; j++) {
    while (busy[j] - busy[i] >= SUSTAINED_WINDOW) i++;
    most = Math.max(most, j - i + 1);
  }
  return most >= SUSTAINED_SECONDS ? most : 0;
}

// Reads WebSocket frames sent by the client (masked) as they stream past,
// counting binary and text frames. It keeps only the first 64 bytes of each
// binary frame and the first 64 KB of each text frame, unmasked, to look for
// audio signatures, and drops them once looked at.
const PEEK_BINARY = 64;
const PEEK_TEXT = 65536;
export function frameParser() {
  let head = Buffer.alloc(0);
  let frame = null;
  const s = {
    binaryFrames: 0,
    binaryBytes: 0,
    textFrames: 0,
    textBytes: 0,
    firstBinary: null,
    textAudio: null,
  };
  let lastData = 0;
  const finishPeek = () => {
    const peek = Buffer.concat(frame.peek);
    if (frame.kind === 2) s.firstBinary ??= signatureAt(peek) ?? "raw";
    else if (frame.kind === 1) s.textAudio ??= base64AudioIn(peek.toString("latin1"));
  };
  return {
    push(d) {
      let at = 0;
      while (at < d.length) {
        if (frame) {
          const take = Math.min(frame.remaining, d.length - at);
          if (frame.peekLeft > 0) {
            const part = Buffer.from(d.subarray(at, at + Math.min(take, frame.peekLeft)));
            for (let i = 0; i < part.length; i++)
              part[i] ^= frame.mask ? frame.mask[(frame.offset + i) % 4] : 0;
            frame.peek.push(part);
            frame.peekLeft -= part.length;
          }
          frame.offset += take;
          frame.remaining -= take;
          at += take;
          if (frame.remaining === 0) {
            finishPeek();
            frame = null;
          }
          continue;
        }
        if (head.length) {
          d = Buffer.concat([head, d.subarray(at)]);
          at = 0;
          head = Buffer.alloc(0);
        }
        const avail = d.length - at;
        if (avail < 2) {
          head = Buffer.from(d.subarray(at));
          return;
        }
        const opcode = d[at] & 0x0f;
        const masked = (d[at + 1] & 0x80) !== 0;
        let len = d[at + 1] & 0x7f;
        let size = 2;
        if (len === 126) size = 4;
        else if (len === 127) size = 10;
        if (masked) size += 4;
        if (avail < size) {
          head = Buffer.from(d.subarray(at));
          return;
        }
        if (len === 126) len = d.readUInt16BE(at + 2);
        else if (len === 127) len = Number(d.readBigUInt64BE(at + 2));
        const mask = masked ? Buffer.from(d.subarray(at + size - 4, at + size)) : null;
        at += size;
        let kind = opcode;
        if (opcode === 0) kind = lastData;
        else if (opcode === 1 || opcode === 2) lastData = opcode;
        if (kind === 2) {
          s.binaryFrames += opcode === 2 ? 1 : 0;
          s.binaryBytes += len;
        } else if (kind === 1) {
          s.textFrames += opcode === 1 ? 1 : 0;
          s.textBytes += len;
        }
        const peekLeft = kind === 2 ? PEEK_BINARY : kind === 1 ? PEEK_TEXT : 0;
        frame = { kind, mask, remaining: len, offset: 0, peek: [], peekLeft };
        if (len === 0) {
          finishPeek();
          frame = null;
        }
      }
    },
    summary() {
      return { ...s };
    },
  };
}

// The verdict for one proxied request or tunnel.
export function classify(e) {
  if (e.frames) {
    const f = e.frames.summary();
    if (f.binaryBytes >= AUDIO_MIN_BYTES)
      return {
        audio: true,
        evidence: `${f.binaryFrames} binary WebSocket frames, ${f.binaryBytes} bytes, first frame ${f.firstBinary}`,
      };
    if (f.textAudio)
      return { audio: true, evidence: `base64 ${f.textAudio} in a WebSocket text frame` };
    return { audio: false, evidence: `${f.binaryBytes} bytes of binary WebSocket frames` };
  }
  const sniffed = sniffAudio(e.sniff, e.contentType);
  if (sniffed) return { audio: true, evidence: sniffed };
  if (e.kind === "tunnel" && e.tls !== false) {
    const seconds = sustainedUpload(e.upBySecond);
    if (seconds)
      return {
        audio: true,
        evidence: `encrypted, sustained upload over ${seconds} seconds (${e.bytesUp} bytes)`,
      };
    return { audio: false, evidence: `encrypted, ${e.bytesUp} bytes up, not sustained` };
  }
  return { audio: false, evidence: `${e.bytesUp} bytes up, no audio signature` };
}
