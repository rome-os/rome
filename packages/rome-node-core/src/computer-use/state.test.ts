import { describe, expect, it } from "@rstest/core";
import {
  parseComputerUseObservation,
  type ComputerUseObservation,
  type ComputerUseObservationDelta,
} from "./protocol.js";
import { mergeComputerUseObservation } from "./state.js";

function observation(
  version: number,
  elements: ComputerUseObservation["elements"],
  delta?: Partial<ComputerUseObservationDelta>,
  complete = true,
): ComputerUseObservation {
  return {
    sessionId: "session",
    observationId: `observation-${version}`,
    stateVersion: version,
    validity: { observedAt: 1, expiresAt: 16, maxAgeSeconds: 15, clock: "remote" },
    complete,
    elements,
    delta: {
      mode: "full",
      lineageId: "lineage",
      baseVersion: null,
      version,
      complete,
      added: elements.map((element) => element.ref),
      changed: [],
      removed: [],
      ...delta,
    },
  };
}
const delta = (
  version: number,
  elements: ComputerUseObservation["elements"],
  added: string[] = [],
  changed: string[] = [],
  removed: string[] = [],
) =>
  observation(version, elements, {
    mode: "delta",
    baseVersion: version - 1,
    added,
    changed,
    removed,
  });

describe("incremental computer-use state", () => {
  it("materializes additions, changes and removals as an independently valid full snapshot", () => {
    const first = observation(1, [{ ref: "a", value: "first" }, { ref: "b" }]);
    const change = delta(2, [{ ref: "a", value: "second" }, { ref: "c" }], ["c"], ["a"], ["b"]);
    const merged = mergeComputerUseObservation(first, change);
    expect(merged.elements).toEqual([{ ref: "a", value: "second" }, { ref: "c" }]);
    expect(merged.delta).toMatchObject({
      mode: "full",
      baseVersion: null,
      added: ["a", "c"],
      changed: [],
      removed: [],
    });
    expect(parseComputerUseObservation(merged, "session")).toBe(merged);
    expect(first.elements[0].value).toBe("first");
    expect(change.delta?.mode).toBe("delta");
    const unchanged = mergeComputerUseObservation(merged, delta(3, []));
    expect(unchanged.elements).toEqual(merged.elements);
    expect(unchanged.stateVersion).toBe(3);
  });

  it("requires an exact complete baseline and does not guess missing changes", () => {
    const first = observation(1, [{ ref: "a" }]);
    for (const prior of [
      undefined,
      { ...first, sessionId: "other" },
      { ...first, stateVersion: 0, delta: { ...first.delta!, version: 0 } },
      observation(1, [{ ref: "a" }], { lineageId: "other" }),
      observation(1, [{ ref: "a" }], {}, false),
    ])
      expect(() => mergeComputerUseObservation(prior, delta(2, []))).toThrow();
    expect(() => mergeComputerUseObservation(first, delta(3, []))).toThrow();
    expect(() =>
      mergeComputerUseObservation(first, observation(2, [], { mode: "delta", baseVersion: 0 })),
    ).toThrow();
  });

  it("requires a newer full lineage when the observation region or direction changes", () => {
    const region = { x: 10, y: 20, width: 100, height: 50 };
    const first = { ...observation(1, [{ ref: "outside-next-region" }]), region };
    const change = { ...delta(2, []), region: { ...region, fromEnd: false } };
    expect(mergeComputerUseObservation(first, change).elements).toEqual(first.elements);
    expect(() => mergeComputerUseObservation(first, { ...change, region: undefined })).toThrow();
    expect(() =>
      mergeComputerUseObservation(first, { ...change, region: { ...region, x: 11 } }),
    ).toThrow();
    const otherDirection = { ...region, fromEnd: true };
    expect(() =>
      mergeComputerUseObservation(first, { ...observation(2, []), region: otherDirection }),
    ).toThrow();
    const next = {
      ...observation(2, [{ ref: "inside-next-region" }], { lineageId: "reverse" }),
      region: otherDirection,
    };
    expect(mergeComputerUseObservation(first, next).elements).toEqual(next.elements);
    expect(() =>
      mergeComputerUseObservation(first, {
        ...next,
        stateVersion: 1,
        delta: { ...next.delta!, version: 1 },
      }),
    ).toThrow();
    expect(() => parseComputerUseObservation({ ...next, delta: undefined }, "session")).toThrow();
  });

  it("rejects reused or unknown identities and inconsistent payloads", () => {
    const first = observation(1, [{ ref: "a" }]);
    for (const change of [
      delta(2, [{ ref: "a" }], ["a"]),
      delta(2, [{ ref: "b" }], [], ["b"]),
      delta(2, [], [], [], ["b"]),
      delta(2, [{ ref: "a" }], ["a"], ["a"]),
      delta(2, [{ ref: "b" }], ["b"], [], ["b"]),
      delta(2, [{ ref: "b" }]),
      delta(2, [], ["b"]),
    ])
      expect(() => mergeComputerUseObservation(first, change)).toThrow();
  });

  it("rejects malformed delta envelopes before consulting a baseline", () => {
    const first = observation(1, [{ ref: "a" }]);
    const good = delta(2, []);
    for (const patch of [
      { mode: "guess" },
      { lineageId: "" },
      { baseVersion: 1.1 },
      { baseVersion: -1 },
      { version: 3 },
      { complete: false },
      { added: null },
      { changed: [1] },
      { removed: ["a", "a"] },
      { added: ["x".repeat(257)] },
      { extra: true },
    ])
      expect(() =>
        mergeComputerUseObservation(first, {
          ...good,
          delta: { ...good.delta, ...patch },
        } as ComputerUseObservation),
      ).toThrow();
    expect(() => mergeComputerUseObservation(first, { ...good, stateVersion: Infinity })).toThrow();
    expect(() =>
      mergeComputerUseObservation(first, observation(2, [], { baseVersion: 1 })),
    ).toThrow();
    expect(() =>
      mergeComputerUseObservation(first, observation(2, [], { changed: ["a"] })),
    ).toThrow();
  });

  it("uses full resets for partial state and lineages, never deriving removals from missing subtrees", () => {
    const first = observation(1, [{ ref: "a" }, { ref: "b" }]);
    const partial = mergeComputerUseObservation(first, observation(2, [{ ref: "a" }], {}, false));
    expect(partial.complete).toBe(false);
    expect(partial.elements).toEqual([{ ref: "a" }]);
    expect(partial.delta?.removed).toEqual([]);
    expect(() => mergeComputerUseObservation(partial, delta(3, []))).toThrow();
    const recovered = mergeComputerUseObservation(partial, observation(3, [{ ref: "b" }]));
    expect(recovered.elements).toEqual([{ ref: "b" }]);
    const rebound = mergeComputerUseObservation(
      recovered,
      observation(1, [{ ref: "new" }], { lineageId: "new-lineage" }),
    );
    expect(rebound.elements).toEqual([{ ref: "new" }]);
    expect(() =>
      mergeComputerUseObservation(rebound, observation(1, [], { lineageId: "new-lineage" })),
    ).toThrow();
  });

  it("bounds the combined state even when each wire patch fits its own budget", () => {
    const first = observation(
      1,
      Array.from({ length: 512 }, (_, index) => ({ ref: `e-${index}` })),
    );
    expect(() =>
      mergeComputerUseObservation(first, delta(2, [{ ref: "extra" }], ["extra"])),
    ).toThrow();
    expect(
      mergeComputerUseObservation(first, delta(2, [{ ref: "extra" }], ["extra"], [], ["e-0"]))
        .elements,
    ).toHaveLength(512);
  });

  it("keeps legacy snapshots standalone without inventing a delta lineage", () => {
    const legacy = observation(10, [{ ref: "legacy" }]);
    delete legacy.delta;
    const merged = mergeComputerUseObservation(observation(1, [{ ref: "old" }]), legacy);
    expect(merged.elements).toEqual([{ ref: "legacy" }]);
    expect(merged.delta).toBeUndefined();
    expect(() => mergeComputerUseObservation(merged, delta(11, []))).toThrow();
  });

  it("agrees with an independent state map over deterministic mixed patches", () => {
    let seed = 1327,
      serial = 0;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed;
    };
    const expected = new Map<string, number>();
    let current = observation(0, []);
    for (let version = 1; version <= 250; version++) {
      const refs = [...expected.keys()],
        added: string[] = [],
        changed: string[] = [],
        removed: string[] = [];
      const payload: ComputerUseObservation["elements"] = [];
      if (!refs.length || random() % 3 === 0) {
        const ref = `e-${++serial}`,
          value = random();
        expected.set(ref, value);
        added.push(ref);
        payload.push({ ref, value });
      } else {
        const ref = refs[random() % refs.length];
        if (random() % 2) {
          expected.delete(ref);
          removed.push(ref);
        } else {
          const value = random();
          expected.set(ref, value);
          changed.push(ref);
          payload.push({ ref, value });
        }
      }
      current = mergeComputerUseObservation(
        current,
        delta(version, payload, added, changed, removed),
      );
      expect(new Map(current.elements.map((element) => [element.ref, element.value]))).toEqual(
        expected,
      );
    }
  });
});
