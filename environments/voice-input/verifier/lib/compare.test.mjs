import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { compare, readWav, resample, stream } from "./compare.mjs";

function wav(samples, rate) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => data.writeInt16LE(s, i * 2));
  const head = Buffer.alloc(44);
  head.write("RIFF", 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write("WAVEfmt ", 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

describe("comparison", () => {
  it("reads a WAV and averages it down to the provider's rate", () => {
    const { samples, rate } = readWav(wav([3, 6, 9, 30, 60, 90], 48000));
    assert.equal(rate, 48000);
    assert.deepEqual([...resample(samples, rate, 16000)], [6, 60]);
  });

  it("times text against the audio it was streamed with", async () => {
    // A provider that writes "hello" once it has heard 1 s of audio and "hello world" at the end.
    const provider = {
      rate: 1000,
      async connect({ onText }) {
        let heard = 0;
        let close;
        return {
          send: (s) => {
            heard += s.length;
            if (heard >= 1000) onText("hello");
          },
          end: () => {
            onText("hello world");
            close();
          },
          done: new Promise((r) => {
            close = r;
          }),
        };
      },
    };
    const result = await stream(provider, { samples: new Int16Array(2000), speed: 20 });
    assert.equal(result.text, "hello world");
    assert.ok(Math.abs(result.firstTextAt - 1) < 0.3, `first text at ${result.firstTextAt}`);
    assert.ok(Math.abs(result.completeAt - 2) < 0.3, `complete at ${result.completeAt}`);
  });

  it("reports a provider without a credential as not checked", async () => {
    delete process.env.SONIOX_API_KEY;
    const { report } = await compare({
      provider: "soniox",
      script: { messages: [] },
      outDir: mkdtempSync(join(tmpdir(), "voice-compare-")),
      log: () => {},
    });
    assert.equal(report.notChecked, "no provider credential: set SONIOX_API_KEY");
  });
});
