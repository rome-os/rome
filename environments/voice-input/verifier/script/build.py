"""Builds the voice input script from selection.json.

    nix-shell script/shell.nix --run "python3 -I script/build.py [out_dir]"

Reads only the rows it needs from each dataset's parquet file over HTTP range
requests, and writes one WAV per message plus manifest.json to out_dir
(default ~/.rome-environments/voice-input/script). Each WAV is 48 kHz mono
16-bit PCM, with LEAD_S of silence before the recording and TAIL_S after it,
so the time of the first and last word in the file is known. The manifest
gives those times, measured on the audio, with the written text and licence.
"""

import hashlib
import io
import json
import os
import re
import subprocess
import sys
import wave

import fsspec
import numpy as np
import pyarrow.parquet as pq

HERE = os.path.dirname(os.path.abspath(__file__))
RATE = 48000
LEAD_S = 1.0
TAIL_S = 6.0
GAP_S = 0.4
FRAME_S = 0.02


def read_rows(url, wanted):
    """The audio bytes of each row whose file name is in `wanted`, read with range requests."""
    found = {}
    with fsspec.open(url, block_size=2**20).open() as f:
        pf = pq.ParquetFile(f)
        for g in range(pf.num_row_groups):
            paths = pf.read_row_group(g, columns=["path"]).column("path").to_pylist()
            names = [os.path.basename(p) for p in paths]
            if wanted is not None and not any(n in wanted for n in names):
                continue
            cols = [c for c in pf.schema_arrow.names if c in ("path", "audio", "transcription", "raw_transcription", "id", "num_samples")]
            table = pf.read_row_group(g, columns=cols).to_pylist()
            for row in table:
                name = os.path.basename(row["path"])
                if (wanted is None or name in wanted) and name not in found:
                    found[name] = row
    return found


def decode(audio_bytes):
    """Any input audio to float samples at RATE, mono, through ffmpeg."""
    out = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", "pipe:0", "-ac", "1", "-ar", str(RATE), "-f", "s16le", "pipe:1"],
        input=audio_bytes,
        capture_output=True,
        check=True,
    ).stdout
    return np.frombuffer(out, dtype=np.int16).astype(np.float32) / 32768.0


def speech_bounds(samples):
    """First and last 20 ms frame whose energy is above a threshold set from the clip itself."""
    frame = int(RATE * FRAME_S)
    n = len(samples) // frame
    rms = np.sqrt(np.mean(samples[: n * frame].reshape(n, frame) ** 2, axis=1) + 1e-12)
    db = 20 * np.log10(rms)
    threshold = max(np.percentile(db, 95) - 30, np.percentile(db, 10) + 10)
    loud = np.nonzero(db > threshold)[0]
    if len(loud) == 0:
        return 0.0, len(samples) / RATE
    return loud[0] * FRAME_S, (loud[-1] + 1) * FRAME_S


def silence(seconds):
    return np.zeros(int(RATE * seconds), dtype=np.float32)


def write_wav(path, samples):
    pcm = (np.clip(samples, -1, 1) * 32767).astype("<i2").tobytes()
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(pcm)
    return hashlib.sha256(open(path, "rb").read()).hexdigest()


def main():
    out_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/.rome-environments/voice-input/script")
    os.makedirs(out_dir, exist_ok=True)
    sel = json.load(open(os.path.join(HERE, "selection.json")))
    by_source = {}
    for m in sel["messages"]:
        by_source.setdefault(m["source"], set()).add(m["file"])

    rows = {}
    for source, files in by_source.items():
        rows.update(read_rows(sel["sources"][source]["parquet"], files))

    manifest = {"selectionVersion": sel["version"], "sampleRate": RATE, "sources": sel["sources"], "messages": []}
    for m in sel["messages"]:
        row = rows[m["file"]]
        samples = decode(row["audio"]["bytes"])
        start, end = speech_bounds(samples)
        audio = np.concatenate([silence(LEAD_S), samples, silence(TAIL_S)])
        wav = f"{m['key']}.wav"
        sha = write_wav(os.path.join(out_dir, wav), audio)
        manifest["messages"].append(
            {
                **m,
                "wav": wav,
                "sha256": sha,
                "seconds": round(len(audio) / RATE, 3),
                "firstWordAt": round(LEAD_S + start, 3),
                "lastWordAt": round(LEAD_S + end, 3),
            }
        )
        print(f"{m['key']}: speech {LEAD_S + start:.2f}-{LEAD_S + end:.2f} s", file=sys.stderr)

    manifest["long"] = build_long(sel, out_dir)
    with open(os.path.join(out_dir, "manifest.json"), "w") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(os.path.join(out_dir, "manifest.json"))


def build_long(sel, out_dir):
    """Consecutive Mandarin recordings in file order, not used in the 20, up to the target length."""
    spec = sel["long"]
    used = {m["file"] for m in sel["messages"]}
    rows = read_rows(sel["sources"][spec["source"]]["parquet"], None)
    plain = re.compile(r"^[一-鿿，。、；：“”！？（）]+$")
    seen_ids = set()
    picked = []
    speech_target = spec["targetSeconds"] - LEAD_S - TAIL_S - spec["pauses"] * spec["pauseSeconds"]
    total = 0.0
    for name in sorted(rows):
        row = rows[name]
        text = row["raw_transcription"]
        if name in used or row["id"] in seen_ids or not plain.match(text):
            continue
        samples = decode(row["audio"]["bytes"])
        start, end = speech_bounds(samples)
        clip = samples[int(start * RATE) : int(end * RATE)]
        if total + len(clip) / RATE + GAP_S > speech_target:
            break
        seen_ids.add(row["id"])
        picked.append((name, text, clip))
        total += len(clip) / RATE + GAP_S

    thirds = {len(picked) // 3, 2 * len(picked) // 3}
    parts = [silence(LEAD_S)]
    sentences = []
    t = LEAD_S
    pauses = []
    for i, (name, text, clip) in enumerate(picked):
        if i in thirds and i > 0:
            parts.append(silence(spec["pauseSeconds"] - GAP_S))
            pauses.append(round(t - GAP_S, 3))
            t += spec["pauseSeconds"] - GAP_S
        sentences.append({"file": name, "text": text, "startsAt": round(t, 3), "endsAt": round(t + len(clip) / RATE, 3)})
        parts += [clip, silence(GAP_S)]
        t += len(clip) / RATE + GAP_S
    parts.append(silence(TAIL_S))
    audio = np.concatenate(parts)
    wav = f"{spec['key']}.wav"
    sha = write_wav(os.path.join(out_dir, wav), audio)
    return {
        "key": spec["key"],
        "language": spec["language"],
        "source": spec["source"],
        "note": spec["note"],
        "wav": wav,
        "sha256": sha,
        "seconds": round(len(audio) / RATE, 3),
        "pausesAt": pauses,
        "firstWordAt": sentences[0]["startsAt"],
        "lastWordAt": sentences[-1]["endsAt"],
        "sentences": sentences,
        "text": "".join(s["text"] for s in sentences),
    }


if __name__ == "__main__":
    main()
