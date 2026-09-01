import { describe, expect, it } from "@rstest/core";

import { PullProgressParser } from "./lima-pull-parser";

describe("PullProgressParser", () => {
  it("returns null for blank and unparseable lines", () => {
    const parser = new PullProgressParser();
    expect(parser.ingest("")).toBeNull();
    expect(parser.ingest("   ")).toBeNull();
    expect(parser.ingest("Pulling from docker.io/library/alpine:latest")).toBeNull();
    expect(parser.ingest("random log line without a colon")).toBeNull();
  });

  it("ignores index/manifest/config sha256 refs — only counts real layers", () => {
    const parser = new PullProgressParser();
    parser.ingest("docker.io/library/alpine:latest: resolving");
    parser.ingest("index-sha256:aaa: done");
    parser.ingest("manifest-sha256:bbb: done");
    parser.ingest("config-sha256:ccc: done");
    const snap = parser.snapshot();
    expect(snap.layersTotal).toBe(0);
    expect(snap.totalBytes).toBe(0);
  });

  it("parses the elapsed-line cumulative bytes (nerdctl's only honest mid-pull counter)", () => {
    const parser = new PullProgressParser();
    expect(parser.ingest("elapsed: 9.3 s    total:  24.7 M (2.7 MiB/s)")).toBeNull();
    expect(parser.snapshot().currentBytes).toBe(Math.round(24.7 * 1024 ** 2));
    parser.ingest("elapsed: 12.0 s   total:  40.5 MiB (3.4 MiB/s)");
    expect(parser.snapshot().currentBytes).toBe(Math.round(40.5 * 1024 ** 2));
    parser.ingest("elapsed: 12.1 s   total:  10.0 MiB");
    expect(parser.snapshot().currentBytes).toBe(Math.round(40.5 * 1024 ** 2));
  });

  it("reads the bare binary units nerdctl actually emits", () => {
    // A real 2026-08-17 pull logged `unrecognised byte unit "Mi"` and `"Gi"`.
    const parser = new PullProgressParser();
    parser.ingest("elapsed: 9.3 s    total:  24.7 Mi (2.7 MiB/s)");
    expect(parser.snapshot().currentBytes).toBe(Math.round(24.7 * 1024 ** 2));
    parser.ingest("elapsed: 30.0 s   total:  1.5 Gi");
    expect(parser.snapshot().currentBytes).toBe(Math.round(1.5 * 1024 ** 3));
  });

  it("sizes a layer from a bare binary unit, so the denominator is right", () => {
    const parser = new PullProgressParser();
    parser.ingest("layer-sha256:a: downloading 0.0 B/2.0 Gi");
    expect(parser.snapshot().totalBytes).toBe(2 * 1024 ** 3);
  });

  it("keeps percent honest when both halves of the ratio are bare binary", () => {
    // Percent is the only number the page renders, and no other test here
    // asserts it. Unresolved units make it read 100 for most of a pull.
    const parser = new PullProgressParser();
    parser.ingest("layer-sha256:a: downloading 0.0 B/2.0 Gi");
    parser.ingest("layer-sha256:b: downloading 0.0 B/1.0 Gi");
    parser.ingest("layer-sha256:a: done");
    parser.ingest("elapsed: 1.0 s   total: 1.0 Gi");
    // 2 of 3 GiB — a completed layer counts in full.
    expect(parser.snapshot().percent).toBeCloseTo(66.7, 0);
    parser.ingest("elapsed: 40.0 s  total: 2.9 Gi");
    expect(parser.snapshot().percent).toBeCloseTo(96.7, 0);
  });

  it("holds percent at null until the first elapsed-tick after the first layer done", () => {
    const parser = new PullProgressParser();
    // Layers announced over several ticks — partial total at every step.
    parser.ingest("layer-sha256:a: downloading 0.0 B/30.0 MiB");
    expect(parser.snapshot().percent).toBeNull();
    parser.ingest("elapsed: 0.1 s   total: 0.0 B");
    expect(parser.snapshot().percent).toBeNull();
    parser.ingest("layer-sha256:b: downloading 0.0 B/70.0 MiB");
    parser.ingest("elapsed: 0.2 s   total: 0.0 B");
    expect(parser.snapshot().percent).toBeNull();
    // First layer transitions to done — sync point armed but not yet fired.
    parser.ingest("layer-sha256:a: done");
    expect(parser.snapshot().percent).toBeNull();
    // Next elapsed line is the sync point — total locks at 100 MiB,
    // percent unlocks against it.
    parser.ingest("elapsed: 1.0 s   total: 30.0 MiB");
    const snap = parser.snapshot();
    expect(snap.totalBytes).toBe(100 * 1024 * 1024);
    expect(snap.percent).toBeCloseTo(30, 1);
  });

  it("locks the stabilized total even if more layer bytes show up later", () => {
    const parser = new PullProgressParser();
    parser.ingest("layer-sha256:a: downloading 0.0 B/30.0 MiB");
    parser.ingest("layer-sha256:b: downloading 0.0 B/70.0 MiB");
    parser.ingest("layer-sha256:a: done");
    parser.ingest("elapsed: 1.0 s   total: 50.0 MiB");
    const locked = parser.snapshot().totalBytes;
    expect(locked).toBe(100 * 1024 * 1024);
    // A late-arriving layer's total must not grow our locked denominator.
    parser.ingest("layer-sha256:c: downloading 0.0 B/200.0 MiB");
    expect(parser.snapshot().totalBytes).toBe(locked);
  });

  it("percent monotonically non-decreasing (high-water mark)", () => {
    const parser = new PullProgressParser();
    // Two layers so allObservedDone stays false after `a` finishes —
    // otherwise we'd switch into the unpacking phase and percent goes null.
    parser.ingest("layer-sha256:a: downloading 0.0 B/50.0 MiB");
    parser.ingest("layer-sha256:b: downloading 0.0 B/50.0 MiB");
    parser.ingest("layer-sha256:a: done");
    parser.ingest("elapsed: 1.0 s   total: 50.0 MiB");
    const p1 = parser.snapshot().percent ?? 0;
    expect(p1).toBeCloseTo(50, 1);
    // Defensive: even if nerdctl's cumulative momentarily drops, percent doesn't.
    parser.ingest("elapsed: 1.1 s   total: 10.0 MiB");
    const p2 = parser.snapshot().percent ?? 0;
    expect(p2).toBeGreaterThanOrEqual(p1);
  });

  it("layer.current and layer.total never regress on later snapshots", () => {
    const parser = new PullProgressParser();
    parser.ingest("layer-sha256:a: downloading 50.0 MiB/100.0 MiB");
    parser.ingest("layer-sha256:a: downloading 0.0 B/100.0 MiB");
    parser.ingest("layer-sha256:a: downloading 0.0 B/50.0 MiB");
    // Aggregated total uses the highest total ever reported.
    expect(parser.snapshot().totalBytes).toBe(100 * 1024 * 1024);
  });

  it("infers unpacking once stabilized + bytes reached + all layers done", () => {
    const parser = new PullProgressParser();
    parser.ingest("layer-sha256:a: downloading 0.0 B/10.0 MiB");
    parser.ingest("layer-sha256:a: done");
    parser.ingest("elapsed: 1.0 s   total: 10.0 MiB");
    const snap = parser.snapshot();
    expect(snap.phase).toBe("unpacking");
    expect(snap.percent).toBeNull();
    expect(snap.status).toBe("Unpacking layers");
  });

  it("switches to unpacking phase when an explicit unpacking line appears", () => {
    const parser = new PullProgressParser();
    parser.ingest("layer-sha256:abc: downloading 4.0 MiB/4.0 MiB");
    parser.ingest("layer-sha256:abc: done");
    parser.ingest("layer-sha256:abc: unpacking");
    expect(parser.snapshot().phase).toBe("unpacking");
  });

  it("markComplete forces a 100% / done snapshot regardless of state", () => {
    const parser = new PullProgressParser();
    parser.ingest("layer-sha256:abc: downloading 1.0 MiB/10.0 MiB");
    parser.markComplete();
    const snap = parser.snapshot();
    expect(snap.phase).toBe("done");
    expect(snap.percent).toBe(100);
    expect(snap.status).toBe("Done");
  });

  it("strips ANSI escape codes before parsing", () => {
    const parser = new PullProgressParser();
    const ESC = String.fromCharCode(0x1b);
    const line = `${ESC}[1Alayer-sha256:abc: downloading 1.0 KiB/2.0 KiB${ESC}[0K`;
    const t = parser.ingest(line);
    expect(t).toEqual({ ref: "layer-sha256:abc", from: null, to: "downloading" });
  });

  it("understands the 'exists' terminal status (cached layer)", () => {
    const parser = new PullProgressParser();
    parser.ingest("layer-sha256:abc: exists");
    parser.ingest("elapsed: 0.1 s   total: 0.0 B");
    const snap = parser.snapshot();
    expect(snap.layersCompleted).toBe(1);
  });
});
